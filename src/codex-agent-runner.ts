/**
 * Trusted Codex CLI runner CORE. Not exposed through MCP until independently reviewed.
 * A successful CLI turn is not proof that its claimed tests passed.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn as nativeSpawn, execFileSync, type ChildProcess } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  requestsForCommand, JobResourceLocks, sharedResourceLocks,
} from "./job-resource-locks.js";
import type { CoachReviewEventStore } from "./coach-review-events.js";
import { GUARDIAN_SOURCE, createGuardianMarker, readGuardianIdentity } from "./coach-agent-guardian.js";
import { AgentObserverStore, normalizeCodexNativeEvent } from "./agent-observer.js";
import {validateCodexSelection, type CodexSelection, type CodexModel, type CodexEffort} from "./coach-model-policy.js";
import { analyzeAgentEfficiency, type AuditTrace } from "./agent-efficiency-audit.js";
import { codexChildEnvironment } from "./codex-proxy-environment.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// Codex currently emits time-ordered UUIDv7 thread IDs; keep valid RFC versions.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Model and reasoning effort are explicitly supplied by the Coach.
// No global frozen model, no fallback to legacy names.
const NODE = "/Users/liz/.local/bin/node";
const CODEX = "/Users/liz/.local/bin/codex";
// Bound long Codex JSON streams without silently truncating their completion events.
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 2000;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_INLINE_DIFF_BYTES = 32 * 1024;
type SnapshotFile = { sha256: string; bytes: number; state: "file" | "deleted" };
type State = "RUNNING" | "COMPLETED" | "FAILED" | "STOPPED" | "INTERRUPTED" | "CLEARED";
type FailureStage = "spawn" | "provider" | "runtime" | "timeout" | "manual_stop" | "evidence";
type CodexErrorCategory =
  "authentication" | "model_unavailable" | "rate_or_quota" |
  "provider_5xx" | "transport" | "timeout" | "unclassified";
/** Classifies only genuine Codex error events, discarding their raw text immediately. */
export function classifyCodexError(raw:Record<string,unknown>):CodexErrorCategory {
  const obj=raw.error && typeof raw.error==="object" && !Array.isArray(raw.error)
    ? raw.error as Record<string,unknown> : {};
  const parts=[raw.message,raw.code,raw.error, obj.message, obj.code]
    .filter((x):x is string=>typeof x==="string").map(x=>x.slice(0,1024));
  const msg=parts.join(" ");
  if(/\b(?:401|403)\b|unauthorized|auth(?:entication|orization) failed|invalid api key|not authenticated|token expired/i.test(msg))return "authentication";
  if(/unknown model|model not found|unsupported model|invalid.model|model.{0,60}(?:does not exist|unavailable|not supported)/i.test(msg))return "model_unavailable";
  if(/\b429\b|rate.limit|quota|too many requests/i.test(msg))return "rate_or_quota";
  if(/\b(?:500|502|503|504)\b|internal server error|service unavailable|bad gateway/i.test(msg))return "provider_5xx";
  if(/econnreset|eai_again|enotfound|certificate|\btls\b|\bssl\b|\bdns\b|stream.{0,25}(?:disconnect|closed|reset)|connection.{0,25}(?:closed|reset|refused)|failed to connect/i.test(msg))return "transport";
  if(/timed out|timeout|deadline exceeded/i.test(msg))return "timeout";
  return "unclassified";
}
type ProcessLike = Pick<ChildProcess, "pid" | "stdin" | "stdout" | "stderr" | "on" | "kill"> & { guardianFd?: ChildProcess["stdio"][3] };
/** Terminate the dedicated process group on Unix, not only the Codex parent. */
function terminateAgent(proc:ProcessLike | undefined, signal:NodeJS.Signals):void {
  if (!proc) return;
  if (process.platform !== "win32" && proc.pid && proc.pid > 0) {
    try {process.kill(-proc.pid,signal);return;}
    catch { /* Fall back to direct process termination. */ }
  }
  try {proc.kill(signal);} catch { /* It may already have exited. */ }
}
type Spawn = (file: string, argv: string[], opts: {
  cwd: string; stdio: ["pipe", "pipe", "pipe"] | ["pipe", "pipe", "pipe", "pipe"]; detached: boolean; env?: NodeJS.ProcessEnv;
}) => ProcessLike;
export interface RunnerInput {
  workspaceId: string;
  workspaceRoot: string;
  operationId: string;
  prompt: string;
  model: CodexModel;
  reasoningEffort: CodexEffort;
  sessionId?: string;
  parentOperationId?: string;
  /** Rework may only begin against its parent source snapshot. */
  expectedFingerprint?: string;
  sandbox: "workspace-write" | "read-only";
  timeoutMs?: number;
  /** Internal-only local Coach reviewer. Never offered as an MCP input. */
  internalReview?: true;
}
export interface RunnerStatus {
  operationId: string;
  workspaceId: string;
  state: State;
  startedAt: string;
  finishedAt?: string;
  threadId?: string;
  exitCode?: number | null;
  evidenceSha256?: string;
  eventId?: number;
  elapsedMs?: number;
  tokenUsage?: unknown;
  /** Whitelisted diagnosis only; never the raw provider error text. */
  errorEventCount?: number;
  lastErrorCategory?: CodexErrorCategory;
  failureStage?: FailureStage;
  executionCompleted?: boolean;
  evidenceState?: "PENDING" | "VERIFIED" | "FAILED" | "NOT_CREATED";
  reviewState?: "READY_FOR_GPT_REVIEW" | "REVIEW_BLOCKED" | "REWORK" | "APPROVED";
  /** Native event progress is distinct from runner heartbeat. */
  lastNativeEventAt?:string;
  nativeEventCount?:number;
  timeSinceNativeEventMs?:number;
  progressState?:"STARTING"|"EVENTS_FLOWING"|"AWAITING_MODEL"|"SUSPECTED_STALL"|"FINISHED";
  activeSelection?:CodexSelection;
  nextSelection?:CodexSelection;
  configRevision?:number;
  reason?: string;
}
export interface EvidencePacket {
  operationId: string;
  workspaceId: string;
  threadId: string;
  exitCode: number;
  eventTypes: string[];
  inputFingerprint: string;
  finalFingerprint: string;
  gitSummary: string | null;
  sourceDiff: string | null;
  stdoutSha256: string;
  stderrSha256: string;
  capturedAt: string;
  invocation: {
    sandbox: RunnerInput["sandbox"];
    reasoningEffort: RunnerInput["reasoningEffort"];
    model?: CodexModel;
    resumed: boolean;
    parentOperationId?: string;
  };
  tokenUsage?: unknown;
  evidenceSha256: string;
}
export interface NativeRunnerOptions {
  events: CoachReviewEventStore;
  nodePath: string;
  codexPath: string;
  locks?: JobResourceLocks;
  maxOutputBytes?: number;
  /** Test-only injection; a production caller must never expose it via MCP. */
  spawn?: Spawn;
  /** Test-only fingerprint injection; never used by production MCP wiring. */
  fingerprint?: (root: string) => Promise<{ sha: string; gitSummary: string | null; changedFiles?: Record<string, SnapshotFile> }>;
  /** Test-only heartbeat cadence; production is fixed at 5000ms. */
  heartbeatIntervalMs?:number;
  observer?: AgentObserverStore;
  auditStore?: import("./coach-review-events.js").CoachReviewEventStore;
  /** Present only in the independent Worker Supervisor process. */
  workerLease?: {workerId:string;generation:number};
}
interface RecordEntry {
  input: RunnerInput;
  status: RunnerStatus;
  promise?: Promise<RunnerStatus>;
  process?: ProcessLike;
  evidence?: EvidencePacket;
  reviewRecommendation?: { decision: "APPROVED"|"REWORK"|"BLOCKED"; reason: string };
  stop?: boolean;
  timedOut?: boolean;
}
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new TypeError("CODEX_INVALID_" + field.toUpperCase());
  }
}
function validate(input: RunnerInput): void {
  assertId(input.workspaceId, "workspace_id");
  assertId(input.operationId, "operation_id");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 10000)
    throw new TypeError("CODEX_INVALID_PROMPT");
  validateCodexSelection(input);
  if (!["workspace-write", "read-only"].includes(input.sandbox))
    throw new TypeError("CODEX_INVALID_OPTIONS");
  if (input.sessionId !== undefined && !UUID.test(input.sessionId))
    throw new TypeError("CODEX_INVALID_SESSION");
  if(input.expectedFingerprint!==undefined &&
      (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint) || !input.parentOperationId))
    throw new TypeError("CODEX_INVALID_REWORK_FINGERPRINT");
  if (input.parentOperationId !== undefined &&
      (!ID.test(input.parentOperationId) || !input.sessionId || !input.expectedFingerprint ||
       input.parentOperationId === input.operationId))
    throw new TypeError("CODEX_INVALID_REWORK_PARENT");
  if (input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 3000 || input.timeoutMs > 3600000))
    throw new TypeError("CODEX_INVALID_TIMEOUT");
}
function directory(root: string): string {
  const path = realpathSync(root);
  if (!statSync(path).isDirectory()) throw new TypeError("CODEX_WORKSPACE_NOT_DIRECTORY");
  return path;
}
function executable(path: string, expected: string, testOnly: boolean): string {
  const actual = realpathSync(path);
  const st = statSync(actual);
  if (!st.isFile() || (process.platform !== "win32" && (st.mode & 0o111) === 0))
    throw new TypeError("CODEX_EXECUTABLE_NOT_ALLOWED");
  if ((!testOnly || path === NODE) && actual !== realpathSync(expected))
    throw new TypeError("CODEX_EXECUTABLE_NOT_ALLOWED");
  return path;
}
function operationIdentity(input: RunnerInput): string {
  return hash(JSON.stringify({ ...input, prompt: hash(input.prompt) }));
}
function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}
function fileHash(path: string): string {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return hash("symlink:" + readlinkSync(path));
  if (!st.isFile()) return hash("special:" + st.mode);
  if (st.size > MAX_SNAPSHOT_BYTES) throw new Error("CODEX_SNAPSHOT_TOO_LARGE");
  return hash(readFileSync(path));
}
/** Capture actual Git HEAD/index/modified and untracked contents, or a bounded file tree. */
export async function captureCodexFingerprint(root: string): Promise<{sha: string; gitSummary: string | null; changedFiles: Record<string, SnapshotFile>}> {
  const workspace = directory(root);
  const runGit = (...args: string[]) => execFileSync("/usr/bin/git", args, {
    cwd: workspace, timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  }) as Buffer;
  const h = createHash("sha256");
  let gitRoot: string | undefined;
  try {
    gitRoot = (runGit("rev-parse", "--show-toplevel").toString("utf8").trim());
  } catch { /* Scratch directories without .git are supported. */ }
  if (gitRoot === workspace) {
    // Fresh Git repositories can have an unborn HEAD. Still hash index and
    // untracked bytes rather than rejecting a valid first-edit workspace.
    let head:Buffer;
    try {head=runGit("rev-parse", "HEAD");}
    catch {head=Buffer.from("UNBORN_HEAD");}
    const index = runGit("ls-files", "-s", "-z");
    const status = runGit("status", "--porcelain=v1", "-z", "--untracked-files=all");
    const dirty = runGit("ls-files", "-m", "-o", "--exclude-standard", "-z");
    const deleted = runGit("ls-files", "-d", "-z");
    h.update("git:"); h.update(head); h.update(index); h.update(status); h.update(deleted);
    const paths = [...new Set([...dirty.toString("utf8").split("\0"), ...deleted.toString("utf8").split("\0")].filter(Boolean))].sort();
    if (paths.length > MAX_SNAPSHOT_FILES) throw new Error("CODEX_SNAPSHOT_TOO_MANY_FILES");
    let size = 0;
    const changedFiles: Record<string, SnapshotFile> = Object.create(null) as Record<string, SnapshotFile>;
    for (const entry of paths) {
      const path = join(workspace, entry);
      const rel = relative(workspace, path);
      if (rel === ".." || rel.startsWith(".." + sep)) throw new Error("CODEX_SNAPSHOT_UNSAFE_PATH");
      let snapshot: SnapshotFile;
      try {
        const st = lstatSync(path);
        size += st.isFile() ? st.size : 0;
        snapshot = { sha256: fileHash(path), bytes: st.isFile() ? st.size : 0, state: "file" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        snapshot = { sha256: hash("deleted:" + entry), bytes: 0, state: "deleted" };
      }
      if (size > MAX_SNAPSHOT_BYTES) throw new Error("CODEX_SNAPSHOT_TOO_LARGE");
      h.update(entry); h.update(snapshot.sha256);
      changedFiles[entry] = snapshot;
    }
    return { sha:h.digest("hex"), changedFiles, gitSummary: "HEAD=" + head.toString("utf8").trim() +
      "; status_entries=" + status.toString("utf8").split("\0").filter(Boolean).length +
      "; modified_or_untracked=" + paths.length };
  }
  // Include .devspace in the fingerprint to detect manifest/config edits,
  // even though its administrative contents are never returned as source diff.
  const skip = new Set([".git", "node_modules", "dist", ".next", ".venv", "venv"]);
  let count = 0, bytes = 0;
  const changedFiles: Record<string, SnapshotFile> = Object.create(null) as Record<string, SnapshotFile>;
  const walk = (dir: string, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      if (skip.has(name)) continue;
      const rel = prefix ? prefix + "/" + name : name;
      const abs = join(dir,name);
      const st = lstatSync(abs);
      if (st.isDirectory()) { walk(abs,rel); continue; }
      count++; bytes += st.isFile() ? st.size : 0;
      if (count > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES)
        throw new Error("CODEX_SNAPSHOT_LIMIT");
      const sha256=fileHash(abs);
      h.update(rel); h.update(sha256);
      changedFiles[rel]={sha256,bytes:st.isFile()?st.size:0,state:"file"};
    }
  };
  walk(workspace);
  return { sha:h.digest("hex"), changedFiles, gitSummary:"non-git snapshot; files=" + count };
}

/** Bounded Git diff or small non-Git source snapshot; never silently discard evidence. */
export function captureCodexSourceDiff(
  root: string,
  beforeFiles?: Record<string, SnapshotFile>,
  afterFiles?: Record<string, SnapshotFile>,
): string {
  const workspace = directory(root);
  const runGit = (...args: string[]) => execFileSync("/usr/bin/git", args, {
    cwd: workspace, timeout: 5000, maxBuffer: MAX_SNAPSHOT_BYTES * 2,
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }) as string;
  const denied = (path:string) =>
    /(^|\/)(?:\.devspace|\.env(?:\..*)?|[^/]*(?:secret|token|password|credential|apikey|private)[^/]*)(?:$|\/)/i.test(path);
  const safeText=(path:string)=>{
    if(denied(path))throw new Error("CODEX_EVIDENCE_SENSITIVE_PATH");
    const file=join(workspace,path);
    const rel=relative(workspace,file);
    if(rel===".."||rel.startsWith(".."+sep))throw new Error("CODEX_EVIDENCE_PATH_ESCAPE");
    const st=lstatSync(file);
    if(!st.isFile()||st.size>MAX_EVIDENCE_BYTES)throw new Error("CODEX_EVIDENCE_UNSAFE_FILE");
    const bytes=readFileSync(file);
    if(bytes.includes(0))throw new Error("CODEX_EVIDENCE_BINARY_SOURCE");
    return bytes.toString("utf8");
  };
  let gitRoot:string|undefined;
  try { gitRoot=runGit("rev-parse","--show-toplevel").trim(); }
  catch { /* A directory outside Git is supported by a small content snapshot. */ }
  let result="";
  // A scoped workspace can live below an ancestor Git repository without
  // being its Git root. Fingerprinting already treats it as a bounded
  // non-Git snapshot; evidence must use the SAME confined semantics.
  // Never run ancestor Git status/diff: those could include other owners' files.
  if(gitRoot!==workspace)gitRoot=undefined;
  if(gitRoot){
    const changes=runGit("status","--porcelain=v1","-z","--untracked-files=all")
      .split("\0").filter(Boolean);
    const paths:string[]=[];
    for(let i=0;i<changes.length;i++){
      const record=changes[i];
      if(record.length<4 || record[2]!==" ")throw new Error("CODEX_EVIDENCE_INVALID_STATUS");
      if(record.startsWith("R")||record.startsWith("C")||record[1]==="R"||record[1]==="C")
        throw new Error("CODEX_EVIDENCE_RENAME_REQUIRES_MANUAL_REVIEW");
      const path=record.slice(3);
      paths.push(path);
    }
    const baseline = beforeFiles ?? Object.create(null) as Record<string, SnapshotFile>;
    const finalFiles = Object.assign(Object.create(null) as Record<string, SnapshotFile>, afterFiles ?? {});
    // Fingerprints list dirty/untracked files only. A file restored to HEAD
    // disappears from that list, so read its real final state before building
    // a manifest; otherwise a clean restored file would be mislabeled deleted.
    for (const path of [...new Set([...paths, ...Object.keys(baseline), ...Object.keys(finalFiles)])]) {
      if (finalFiles[path]) continue;
      const file = join(workspace, path);
      const rel = relative(workspace, file);
      if (rel === ".." || rel.startsWith(".." + sep)) throw new Error("CODEX_EVIDENCE_PATH_ESCAPE");
      try {
        const st = lstatSync(file);
        finalFiles[path] = { sha256: fileHash(file), bytes: st.isFile() ? st.size : 0, state: "file" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        finalFiles[path] = { sha256: hash("deleted:" + path), bytes: 0, state: "deleted" };
      }
    }
    const changedPaths = [...new Set([...paths, ...Object.keys(baseline), ...Object.keys(finalFiles)])]
      .filter((path) => baseline[path]?.sha256 !== finalFiles[path]?.sha256 ||
        baseline[path]?.state !== finalFiles[path]?.state);
    for (const path of changedPaths) if (denied(path)) throw new Error("CODEX_EVIDENCE_SENSITIVE_PATH");
    let untracked:string[]=[];
    if(changedPaths.length){
      let hasHead=true;
      try { runGit("rev-parse","HEAD"); }
      catch {hasHead=false;}
      if(hasHead){
        result=runGit("--literal-pathspecs","diff","--no-ext-diff","--no-color","HEAD","--",...changedPaths);
      }else{
        result=runGit("--literal-pathspecs","diff","--no-ext-diff","--no-color","--cached","--",...changedPaths)+
          runGit("--literal-pathspecs","diff","--no-ext-diff","--no-color","--",...changedPaths);
      }
      untracked=runGit("ls-files","--others","--exclude-standard","-z")
        .split("\0").filter((path) => path && changedPaths.includes(path));
    }
    const hasOversizedUntracked=untracked.some((path)=>(finalFiles[path]?.bytes??0)>MAX_INLINE_DIFF_BYTES);
    if(!hasOversizedUntracked){
      for(const path of untracked)result+="\n--- /dev/null\n+++ b/"+path+"\n"+safeText(path);
    }
    if(changedPaths.some((path)=>baseline[path]) || hasOversizedUntracked ||
       Buffer.byteLength(result,"utf8")>MAX_INLINE_DIFF_BYTES){
      const manifest=changedPaths.map((path)=>({path,
        beforeSha256:baseline[path]?.sha256??null,
        afterSha256:finalFiles[path]?.sha256??null,
        bytes:finalFiles[path]?.bytes??0,
        state:finalFiles[path]?.state??"deleted"}));
      result="CODEX_SCOPED_GIT_SHA256_MANIFEST_V1\n"+JSON.stringify({fullInventory:true,files:manifest});
    }
  }else{
    // The 32 MiB/2000-file scoped snapshot is preserved. Small text
    // workspaces have readable source. Larger maps / binaries get an ENTIRE
    // path+size+SHA manifest, never a truncated partial source diff.
    // The independent reviewer can read the files and verify their hashes.
    const skip=new Set([".git",".devspace","node_modules","dist",".next",".venv","venv"]);
    const inventory:Array<{path:string;bytes:number;sha256:string}>=[];
    let count=0,bytes=0, readable="", hashOnly=false;
    const walk=(dir:string,prefix="")=>{
      for(const name of readdirSync(dir).sort()){
        if(skip.has(name))continue;
        const path=prefix?prefix+"/"+name:name;
        if(denied(path)){
          if(beforeFiles && afterFiles && beforeFiles[path]?.sha256===afterFiles[path]?.sha256 &&
             beforeFiles[path]?.state===afterFiles[path]?.state)continue;
          throw new Error("CODEX_EVIDENCE_SENSITIVE_PATH");
        }
        const abs=join(dir,name),st=lstatSync(abs);
        if(st.isDirectory()){walk(abs,path);continue;}
        if(!st.isFile())throw new Error("CODEX_EVIDENCE_UNSAFE_FILE");
        count++; bytes+=st.size;
        if(count>MAX_SNAPSHOT_FILES)throw new Error("CODEX_EVIDENCE_TOO_MANY_FILES");
        if(st.size>MAX_SNAPSHOT_BYTES||bytes>MAX_SNAPSHOT_BYTES)
          throw new Error("CODEX_EVIDENCE_TOO_LARGE");
        const content=readFileSync(abs);
        inventory.push({path,bytes:content.length,sha256:createHash("sha256").update(content).digest("hex")});
        if(!hashOnly&&!content.includes(0)){
          const next=readable+"\n--- /dev/null\n+++ b/"+path+"\n"+content.toString("utf8");
          // Keep enough space for the rest of the signed evidence packet.
          if(Buffer.byteLength(next,"utf8")<=16*1024)readable=next;
          else hashOnly=true;
        }else hashOnly=true;
      }
    };
    walk(workspace);
    if(beforeFiles && afterFiles){
      const changed=[...new Set([...Object.keys(beforeFiles),...Object.keys(afterFiles)])]
        .filter((path)=>beforeFiles[path]?.sha256!==afterFiles[path]?.sha256 ||
          beforeFiles[path]?.state!==afterFiles[path]?.state);
      for(const path of changed)if(denied(path))throw new Error("CODEX_EVIDENCE_SENSITIVE_PATH");
      const files=changed.map((path)=>({path,beforeSha256:beforeFiles[path]?.sha256??null,
        afterSha256:afterFiles[path]?.sha256??null,bytes:afterFiles[path]?.bytes??0,
        state:afterFiles[path]?.state??"deleted"}));
      let inline="";
      let canInline=true;
      for(const file of files){
        if(file.state==="deleted"){
          inline+=`\n--- ${file.path}\n+++ /dev/null\n# beforeSha256=${file.beforeSha256}\n`;
          continue;
        }
        if(file.bytes>MAX_INLINE_DIFF_BYTES){canInline=false;break;}
        const content=readFileSync(join(workspace,file.path));
        if(content.includes(0)){canInline=false;break;}
        inline+=`\n--- ${file.path}\n+++ ${file.path}\n# beforeSha256=${file.beforeSha256??"absent"} afterSha256=${file.afterSha256}\n${content.toString("utf8")}`;
        if(Buffer.byteLength(inline,"utf8")>MAX_INLINE_DIFF_BYTES){canInline=false;break;}
      }
      result=canInline?inline:"CODEX_SCOPED_NON_GIT_SHA256_MANIFEST_V1\n"+
        JSON.stringify({fullInventory:false,files});
    }else if(hashOnly){
      result="CODEX_SCOPED_NON_GIT_SHA256_MANIFEST_V1\n"+
        JSON.stringify({files:inventory,fullInventory:true,totalBytes:bytes});
      if(Buffer.byteLength(result,"utf8")>MAX_EVIDENCE_BYTES)
        throw new Error("CODEX_EVIDENCE_TOO_LARGE");
    }else result=readable;
  }
  if(Buffer.byteLength(result,"utf8")>MAX_EVIDENCE_BYTES)
    throw new Error("CODEX_EVIDENCE_TOO_LARGE");
  return result;
}

export class NativeCodexAgentRunner {
  private readonly records = new Map<string, RecordEntry>();
  private readonly locks: JobResourceLocks;
  private readonly spawn: Spawn;
  private readonly maxOutput: number;
  private readonly nodePath: string;
  private readonly codexPath: string;
  constructor(private readonly options: NativeRunnerOptions) {
    this.locks = options.locks ?? sharedResourceLocks;
    this.spawn = options.spawn ?? ((file,args,opts) => nativeSpawn(file,args,opts));
    const test = Boolean(options.spawn);
    this.nodePath = executable(options.nodePath, NODE, test);
    this.codexPath = executable(options.codexPath, CODEX, test);
    this.maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    if(options.heartbeatIntervalMs!==undefined &&
       (!test || !Number.isInteger(options.heartbeatIntervalMs) ||
        options.heartbeatIntervalMs<10 || options.heartbeatIntervalMs>5000))
      throw new TypeError("CODEX_INVALID_HEARTBEAT_INTERVAL");
    if (!Number.isInteger(this.maxOutput) || this.maxOutput < 4096 || this.maxOutput > DEFAULT_MAX_OUTPUT)
      throw new TypeError("CODEX_INVALID_OUTPUT_LIMIT");
  }
  run(input: RunnerInput): Promise<RunnerStatus> {
    validate(input);
    const root = directory(input.workspaceRoot);
    const canonical = { ...input, workspaceRoot:root };
    const old = this.records.get(input.operationId);
    if (old) {
      if (operationIdentity(old.input) !== operationIdentity(canonical))
        throw new Error("CODEX_OPERATION_ID_CONFLICT");
      return old.promise ?? Promise.resolve({ ...old.status });
    }
    const durable=this.options.events.getAgentRun(input.workspaceId,input.operationId);
    if(durable){
      if(durable.requestSha256!==operationIdentity(canonical))
        throw new Error("CODEX_OPERATION_DURABLE_IDENTITY_CONFLICT");
      // The durable row is the idempotent receipt after a process restart.
      // Return its observed state; never relaunch an operation from disk.
      return Promise.resolve(this.status(input.operationId,input.workspaceId));
    }
    if(this.options.events.hasInterruptedRun(input.workspaceId))
      throw new Error("CODEX_WORKSPACE_QUARANTINED_UNRESOLVED_AGENT");
    const record: RecordEntry = {
      input: canonical,
      status: { operationId: input.operationId, workspaceId:input.workspaceId,
        state:"RUNNING", startedAt:new Date().toISOString() },
    };
    this.records.set(input.operationId,record);
    record.promise = this.execute(record);
    return record.promise;
  }
  /** Begin a bounded task without waiting for model completion. */
  start(input: RunnerInput): RunnerStatus {
    const running=this.run(input);
    // execute() records failure status internally; never leak an unhandled rejection.
    void running.catch(()=>{});
    return this.status(input.operationId,input.workspaceId);
  }
  status(operationId: string,workspaceId?:string): RunnerStatus {
    assertId(operationId,"operation_id");
    const record=this.records.get(operationId);
    if (record) {
      if(workspaceId && record.status.workspaceId!==workspaceId)
        throw new Error("CODEX_WORKSPACE_MISMATCH");
      const config=this.options.events.getRunConfig(record.status.workspaceId,operationId);
      const now=Date.now();
      const elapsed=now-Date.parse(record.status.startedAt);
      const silence=record.status.lastNativeEventAt
        ?now-Date.parse(record.status.lastNativeEventAt):elapsed;
      const progressState=record.status.state!=="RUNNING"?"FINISHED":
        silence>=120_000?"SUSPECTED_STALL":
        !record.status.nativeEventCount && silence<15_000?"STARTING":
        silence>=15_000?"AWAITING_MODEL":"EVENTS_FLOWING";
      return {...record.status,elapsedMs:record.status.elapsedMs??elapsed,
        progressState,
        ...(record.status.state==="RUNNING"?{timeSinceNativeEventMs:silence}:{}),
        activeSelection:config?.active??{model:record.input.model,reasoningEffort:record.input.reasoningEffort},
        nextSelection:config?.next??{model:record.input.model,reasoningEffort:record.input.reasoningEffort},
        configRevision:config?.revision??0};
    }
    if(workspaceId){
      const durable=this.options.events.getAgentRun(workspaceId,operationId);
      if(durable){
        const config=this.options.events.getRunConfig(workspaceId,operationId);
        let evidence:{exitCode?:unknown;evidenceSha256?:unknown}|undefined;
        if(durable.state==="COMPLETED")try{evidence=this.options.events.getEvidence(workspaceId,operationId) as typeof evidence;}catch{/* Corrupt proof remains unavailable. */}
        return {operationId,workspaceId,state:durable.state,progressState:"FINISHED",
        ...(config?{activeSelection:config.active,nextSelection:config.next,configRevision:config.revision}:{}),
        startedAt:durable.startedAt,...(durable.finishedAt?{finishedAt:durable.finishedAt}:{}),
        ...(durable.threadId?{threadId:durable.threadId}:{}),
        ...(Number.isSafeInteger(evidence?.exitCode)?{exitCode:Number(evidence?.exitCode)}:{}),
        ...(typeof evidence?.evidenceSha256==="string"?{evidenceSha256:evidence.evidenceSha256}:{}),
        ...(durable.eventId?{eventId:durable.eventId}:{}),
        ...(durable.reason?{reason:durable.reason}:{})};
      }
    }
    throw new Error("CODEX_OPERATION_NOT_FOUND");
  }
  /** Queue a durable, revision-checked change for the next explicitly
   * approved Codex turn. Existing subprocess argv is never modified.
   */
  queueNextSelection(input:{workspaceId:string;operationId:string;expectedRevision:number;selection:CodexSelection}) {
    this.status(input.operationId,input.workspaceId);
    const config=this.options.events.queueRunConfig(input);
    this.options.observer?.emit({workspaceId:input.workspaceId,operationId:input.operationId,
      kind:"status",phase:"runner.config_queued",status:"NEXT_TURN",count:config.revision});
    return config;
  }
  activeOperationsForWorkspace(workspaceId:string):string[] {
    return [...this.records.values()].filter(r=>r.input.workspaceId===workspaceId &&
      r.status.state==="RUNNING").map(r=>r.input.operationId);
  }
  /** A structured verdict is advisory, only accessible in-process after a
   * completed, signed independent reviewer run. Never a remote status field. */
  getReviewRecommendation(operationId:string,workspaceId?:string) {
    const entry=this.records.get(operationId);
    if(entry?.status.state==="COMPLETED")return entry.reviewRecommendation;
    return workspaceId?this.options.events.getReviewRecommendation(workspaceId,operationId):undefined;
  }
  getEvidence(operationId: string): EvidencePacket | undefined {
    assertId(operationId,"operation_id");
    const evidence=this.records.get(operationId)?.evidence;
    return evidence ? {...evidence,eventTypes:[...evidence.eventTypes]} : undefined;
  }
  async stop(operationId: string,workspaceId?:string): Promise<boolean> {
    assertId(operationId,"operation_id");
    const r=this.records.get(operationId);
    if(r&&workspaceId&&r.status.workspaceId!==workspaceId)throw new Error("CODEX_WORKSPACE_MISMATCH");
    if (!r || r.status.state!=="RUNNING") return false;
    r.stop=true;
    r.status.failureStage="manual_stop";
    terminateAgent(r.process,"SIGTERM");
    const escalation=r.process ? setTimeout(()=>terminateAgent(r.process,"SIGKILL"),1500) : undefined;
    try {
      if (r.promise) await r.promise;
    } catch { /* status has the recorded failure. */ }
    finally {if(escalation)clearTimeout(escalation);}
    return true;
  }
  async close(): Promise<void> {
    await Promise.all([...this.records.values()].filter(r=>r.status.state==="RUNNING")
      .map(r=>this.stop(r.input.operationId)));
  }
  private async execute(r:RecordEntry): Promise<RunnerStatus> {
    const input=r.input;
    const args=["exec","--json","--sandbox",input.sandbox,"--skip-git-repo-check",
      "--ignore-user-config","--disable","chronicle","--model",input.model,"-c",
      'model_reasoning_effort="' + input.reasoningEffort + '"'];
    if (input.sessionId) args.push("resume",input.sessionId);
    args.push("-"); // Codex documented stdin-prompt sentinel.
    const leaseId="codex-agent:"+randomUUID();
    let locked=false;
    let journalClaimed=false;
    let timer:NodeJS.Timeout|undefined;
    let killTimer:NodeJS.Timeout|undefined;
    let heartbeatTimer:NodeJS.Timeout|undefined;
    let exitCode=-1;
    let completed=false, failed=false, oversize=false, threadId:string|undefined, usage:unknown;
    let malformedEvents=false, agentErrorEvent=false;
    const types:string[]=[];
    const auditTrace: AuditTrace[]=[];
    let beforeSha:string|undefined, afterSha:string|undefined;
    // Incremental hashes avoid buffering several megabytes of tool output.
    const stdoutDigest=createHash("sha256");
    const stderrDigest=createHash("sha256");
    let outSize=0,errSize=0;
    let remaining="";
    const decoder=new StringDecoder("utf8");
    const parseLine=(line:string)=>{
      if (!line.trim()) return;
      if (types.length >= 4000) { failed=true; malformedEvents=true; return; }
      try {
        const raw=JSON.parse(line) as Record<string,unknown>;
        const type=typeof raw.type==="string" ? raw.type : "";
        if (!type) {failed=true;malformedEvents=true;return;}
        types.push(type);
        if(input.internalReview && type==="item.completed") {
          const item=raw.item;
          if(item && typeof item==="object" && !Array.isArray(item)) {
            const candidate=item as Record<string,unknown>;
            if(candidate.type==="agent_message" && typeof candidate.text==="string" &&
               candidate.text.length<=1600) {
              // Require one machine-readable bounded final message. Text is
              // NOT included in the public observer or status response.
              try {
                const parsed=JSON.parse(candidate.text) as Record<string,unknown>;
                if(["APPROVED","REWORK","BLOCKED"].includes(String(parsed.decision)) &&
                    typeof parsed.reason==="string" && parsed.reason.length>=3 &&
                    parsed.reason.length<=350 && !/[\u0000-\u001f]/.test(parsed.reason)) {
                  r.reviewRecommendation={
                    decision:parsed.decision as "APPROVED"|"REWORK"|"BLOCKED",
                    reason:parsed.reason,
                  };
                  r.status.reviewState=parsed.decision==="BLOCKED"?"REVIEW_BLOCKED":
                    parsed.decision==="REWORK"?"REWORK":"APPROVED";
                }
              } catch { /* Invalid reviewer response becomes BLOCKED by policy. */ }
            }
          }
        }
        r.status.lastNativeEventAt=new Date().toISOString();
        r.status.nativeEventCount=(r.status.nativeEventCount??0)+1;
        // Security-critical native JSONL projection is separately fixture-tested.
        // Unknown or sensitive event categories intentionally yield no observer record.
        const projected=normalizeCodexNativeEvent(input.workspaceId,input.operationId,raw);
        if(projected){
          const event=this.options.observer?.emit(projected);
          const p=projected as typeof projected & {actionId?:string;inputHash?:string;sourceMutation?:boolean};
          auditTrace.push({id:String(event?.cursor ?? types.length),actionId:p.actionId,kind:p.kind,at:new Date().toISOString(),phase:p.phase,status:p.status,tool:p.tool,inputHash:p.inputHash,sourceMutation:p.sourceMutation});
        }
        if (type==="thread.started") {
          if (threadId || typeof raw.thread_id!=="string" || !UUID.test(raw.thread_id)) failed=true;
          else threadId=raw.thread_id;
        }
        if (type==="turn.completed") {
          completed=true;
          const u=raw.usage;
          if(u && typeof u==="object" && !Array.isArray(u)) {
            const fields=["input_tokens","cached_input_tokens","output_tokens","reasoning_output_tokens"];
            const cleaned:Record<string,number>={};
            for(const key of fields) {
              const v=(u as Record<string,unknown>)[key];
              if(typeof v==="number" && Number.isSafeInteger(v) && v>=0)cleaned[key]=v;
            }
            usage=cleaned;
          }
        }
        // Codex can emit recoverable transport/retry "error" events before
        // eventually producing a valid turn.completed and exit code 0.
        // Only turn.failed is terminal. An error after completion is an
        // invalid event order and must not silently pass verification.
        if (type==="turn.failed") {failed=true;agentErrorEvent=true;
          r.status.lastErrorCategory=classifyCodexError(raw);}
        if (type==="error") {
          agentErrorEvent=true;
          r.status.errorEventCount=(r.status.errorEventCount??0)+1;
          r.status.lastErrorCategory=classifyCodexError(raw);
          if(completed)failed=true;
        }
      } catch { failed=true;malformedEvents=true; }
    };
    const append=(c:Buffer,isStdout:boolean)=>{
      if (isStdout) {stdoutDigest.update(c);outSize+=c.length;}
      else {stderrDigest.update(c);errSize+=c.length;}
      // Keep a hard resource budget while hashing the actual bytes, never a truncated prefix.
      if ((isStdout?outSize:errSize)>this.maxOutput) {oversize=true;failed=true;return;}
      if(isStdout && !oversize) {
        remaining+=decoder.write(c);
        // Drain complete JSON lines before enforcing a bound on the unfinished line.
        const lines=remaining.split(/\r?\n/);
        remaining=lines.pop() ?? "";
        if (remaining.length>this.maxOutput) {failed=true;malformedEvents=true;remaining="";return;}
        for(const line of lines)parseLine(line);
      }
    };
    const started=Date.now();
    try {
      this.locks.acquire({jobId:leaseId,runner:"npm",workspaceRoot:input.workspaceRoot,
        requests:requestsForCommand({argv:[this.codexPath,...args],workspaceRoot:input.workspaceRoot})});
      locked=true;
      this.options.events.claimAgentRun({workspaceId:input.workspaceId,
        operationId:input.operationId,requestSha256:operationIdentity(input),
        ...(this.options.workerLease?{workerId:this.options.workerLease.workerId,generation:this.options.workerLease.generation}:{})});
      journalClaimed=true;
      this.options.events.recordRunConfig(input.workspaceId,input.operationId,
        {model:input.model,reasoningEffort:input.reasoningEffort});
      const before=this.options.fingerprint
        ? await this.options.fingerprint(input.workspaceRoot)
        : await captureCodexFingerprint(input.workspaceRoot);
      if(input.expectedFingerprint && before.sha!==input.expectedFingerprint)
        throw new Error("CODEX_REWORK_STALE_WORKTREE");
      if(r.stop) throw new Error("CODEX_CANCELLED_BEFORE_SPAWN");
      const marker=createGuardianMarker();
      const spawnArgs = this.options.spawn
        ? [this.codexPath,...args]
        : ["-e",GUARDIAN_SOURCE,"--",marker,this.codexPath,...args];
      const child=this.spawn(this.nodePath,spawnArgs,
        {cwd:input.workspaceRoot,stdio:this.options.spawn ? ["pipe","pipe","pipe"] : ["pipe","pipe","pipe","pipe"],detached:process.platform!=="win32",
          ...(!this.options.spawn?{env:codexChildEnvironment()}: {})});
      r.process=child;
      child.on("error",()=>{failed=true;r.status.failureStage="spawn";});
      // Attach output capture BEFORE identity polling; Codex may emit its
      // thread.started JSON prior to consuming stdin.
      child.stdout?.on("data",(c:Buffer)=>append(c,true));
      child.stderr?.on("data",(c:Buffer)=>append(c,false));
      if (!this.options.spawn) {
        let identity=readGuardianIdentity(child.pid ?? -1,marker);
        // ps may observe the new process before node -e has populated argv.
        const deadline=Date.now()+1000;
        while(!identity && !failed && Date.now()<deadline){
          await new Promise<void>(resolve=>setTimeout(resolve,25));
          identity=readGuardianIdentity(child.pid ?? -1,marker);
        }
        if(!identity) throw new Error("COACH_GUARDIAN_IDENTITY_UNVERIFIED");
        this.options.events.recordGuardian({workspaceId:input.workspaceId,operationId:input.operationId,identity});
      }
      // The runner sends only the authorized prompt via stdin, never in process argv.
      child.stdin?.on("error",()=>{failed=true;r.status.failureStage="runtime";});
      child.stdin?.end(input.prompt);
      // Transport liveness, NOT a claim of model progress or successful actions.
      if(this.options.observer)heartbeatTimer=setInterval(()=>{
        if(r.status.state==="RUNNING") {
          if(this.options.workerLease) {
            const cursor=this.options.observer?.latestCursor()??0;
            const stillOwned=this.options.events.heartbeatAgentRun({workspaceId:input.workspaceId,
              operationId:input.operationId,workerId:this.options.workerLease.workerId,
              generation:this.options.workerLease.generation,eventCursor:cursor});
            if(!stillOwned) {
              failed=true;
              r.stop=true;
              terminateAgent(r.process,"SIGTERM");
              return;
            }
          }
          this.options.observer?.emit({workspaceId:input.workspaceId,operationId:input.operationId,
            kind:"status",phase:"runner.heartbeat",status:"RUNNING",elapsedMs:Date.now()-started});
        }
      },this.options.spawn?(this.options.heartbeatIntervalMs??5000):5000);
      const code=await new Promise<number>(resolve=>{
        let settled=false;
        const done=(value:number)=>{
          if(settled)return;
          settled=true;
          resolve(value);
        };
        child.on("error",()=>{failed=true;done(-1);});
        child.on("close",(value:number|null)=>done(value ?? -1));
        timer=setTimeout(()=>{
          r.stop=true;
          r.timedOut=true;
          r.status.failureStage="timeout";
          terminateAgent(child,"SIGTERM");
          killTimer=setTimeout(()=>{terminateAgent(child,"SIGKILL");},1500);
        },input.timeoutMs ?? 900000);
      });
      exitCode=code;
      if(!oversize && remaining.trim())parseLine(remaining);
      if(input.sessionId && threadId!==input.sessionId)failed=true;
      const after=this.options.fingerprint
        ? await this.options.fingerprint(input.workspaceRoot)
        : await captureCodexFingerprint(input.workspaceRoot);
      beforeSha=before.sha; afterSha=after.sha;
      const success= !r.stop && !failed && !oversize && code===0 &&
        completed && Boolean(threadId);
      if(success) {
        r.status.executionCompleted=true;
        r.status.evidenceState="PENDING";
        const sourceDiff = captureCodexSourceDiff(input.workspaceRoot,before.changedFiles??{},after.changedFiles??{});
        const evidenceBase={
          operationId:input.operationId,workspaceId:input.workspaceId,
          threadId:threadId!,exitCode:code,eventTypes:types,
          inputFingerprint:before.sha,finalFingerprint:after.sha,
          gitSummary:after.gitSummary,
          sourceDiff,
          stdoutSha256:stdoutDigest.digest("hex"),
          stderrSha256:stderrDigest.digest("hex"),
          capturedAt:new Date().toISOString(),
          invocation:{sandbox:input.sandbox,model:input.model,reasoningEffort:input.reasoningEffort,
            resumed:Boolean(input.sessionId),
            ...(input.parentOperationId?{parentOperationId:input.parentOperationId}:{})},
          ...(usage!==undefined?{tokenUsage:usage}:{}),
        };
        const evidenceSha256=hash(stableStringify(evidenceBase));
        const evidence={...evidenceBase,evidenceSha256};
        if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_EVIDENCE_BYTES)
          throw new Error("CODEX_EVIDENCE_TOO_LARGE");
        const recorded=this.options.events.recordCompletedWithEvidence({
          workspaceId:input.workspaceId,operationId:input.operationId,evidenceSha256,
          packetJson:JSON.stringify(evidence),
        });
        r.evidence=evidence;
        r.status.evidenceSha256=evidenceSha256;
        r.status.eventId=recorded.event_id;
        r.status.evidenceState="VERIFIED";
        if(!input.internalReview)r.status.reviewState="READY_FOR_GPT_REVIEW";
        else if(!r.reviewRecommendation)r.status.reviewState="REVIEW_BLOCKED";
        r.status.state="COMPLETED";
      } else {
        r.status.executionCompleted=false;
        r.status.evidenceState="NOT_CREATED";
        r.status.failureStage ??= r.timedOut?"timeout":r.stop?"manual_stop":agentErrorEvent?"provider":
          code!==0?"runtime":"runtime";
        r.status.state=r.stop?"STOPPED":"FAILED";
        r.status.reason = r.timedOut?"codex_execution_timeout":r.stop?"codex_stopped_by_request"
          : oversize?"codex_json_output_limit_exceeded"
          : malformedEvents?"codex_invalid_json_events"
          : agentErrorEvent?"codex_error_event"
          : code!==0?"codex_nonzero_exit"
          : !threadId?"codex_thread_started_missing"
          : !completed?"codex_turn_completed_missing"
          : "codex_completion_not_verified";
      }
      r.status.threadId=threadId;
      r.status.exitCode=exitCode;
      if(usage!==undefined)r.status.tokenUsage=usage;
    }catch(error){
      r.status.state=r.stop?"STOPPED":"FAILED";
      r.status.reason=error instanceof Error?error.message:"codex_execution_failed";
      if(r.status.executionCompleted){
        r.status.failureStage="evidence";
        r.status.evidenceState="FAILED";
      }else{
        r.status.evidenceState="NOT_CREATED";
        r.status.failureStage ??= r.timedOut?"timeout":r.stop?"manual_stop":"runtime";
      }
      terminateAgent(r.process,"SIGKILL");
      // Never fabricate a completion event on a failure.
    }finally{
      if(timer)clearTimeout(timer);
      if(killTimer)clearTimeout(killTimer);
      if(heartbeatTimer)clearInterval(heartbeatTimer);
      if(journalClaimed){
        try {
          this.options.events.finishAgentRun({workspaceId:input.workspaceId,
            operationId:input.operationId,
            state:r.status.state==="COMPLETED"?"COMPLETED":r.status.state==="STOPPED"?"STOPPED":"FAILED",
            ...(r.status.threadId?{threadId:r.status.threadId}:{}),
            ...(r.status.eventId?{eventId:r.status.eventId}:{}),
            ...(r.status.reason?{reason:r.status.reason}:{}),
            ...(r.reviewRecommendation?{reviewRecommendation:r.reviewRecommendation}:{}),
            ...(this.options.workerLease?{workerId:this.options.workerLease.workerId,generation:this.options.workerLease.generation}:{}),
          });
        } catch {
          r.status.state="FAILED";
          r.status.reason="COACH_AGENT_RUN_JOURNAL_FINALIZATION_FAILED";
        }
      }
      r.status.finishedAt=new Date().toISOString();
      r.status.elapsedMs=Date.now()-started;
      // Persist the task audit before publishing the final observer event,
      // so a panel click after "runner.finalized" sees a complete snapshot.
      // This secondary observability path must not overturn verified code results.
      if (this.options.auditStore) try {
        this.options.auditStore.recordEfficiencyAudit(analyzeAgentEfficiency({
          workspaceId: input.workspaceId, operationId: input.operationId, status: r.status.state,
          start: r.status.startedAt, finish: r.status.finishedAt, tokenUsage: r.status.tokenUsage,
          sourceChange: beforeSha !== undefined && afterSha !== undefined ? beforeSha !== afterSha : undefined,
          trace: auditTrace,
        }));
      } catch { r.status.reason = r.status.reason ?? "audit_unavailable"; }
      // A native turn.completed is NOT proof that the runner's safety and
      // evidence checks succeeded. This terminal state is authoritative.
      this.options.observer?.emit({
        workspaceId:input.workspaceId,operationId:input.operationId,
        kind:"end",phase:"runner.finalized",status:r.status.state,
      });
      if(locked)this.locks.release(leaseId);
    }
    return {...r.status};
  }
}
