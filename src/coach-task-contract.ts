/** Frozen developer authority. No prompt-only compatibility path for new launches. */
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { parseDocument } from "yaml";
import * as z from "zod/v4";

export const safeTaskId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
export const taskReferenceSchema = z.object({workspaceId:z.string(),taskId:z.string(),taskPath:z.string(),version:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type TaskReference = z.infer<typeof taskReferenceSchema>;
export interface TaskDiagnostic {code:string;keyword:string;reason:string;remediation:string;retryable:boolean}
export class TaskGateError extends Error {
  readonly diagnostic;
  constructor(code:string,keyword:string,reason:string) {
    super(code+": "+keyword);
    this.diagnostic={schema:"DEVSPACE_TASK_GATE_RESULT_V1",ok:false,codex_started:false,
      diagnostics:[{code,keyword,reason,remediation:"Web GPT must create or explicitly revise the complete TASK, freeze its new version, then retry with the returned workspace-bound reference.",retryable:true}]};
  }
}
export function taskFailure(code:string,keyword:string,reason:string):never {throw new TaskGateError(code,keyword,reason);}
export const sha256=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
const sections=["WHY","GOAL","CONTEXT","SCOPE","IMPLEMENTATION","ACCEPTANCE","TEST","CONSTRAINTS","DONE"];
const why=["PROBLEM","EVIDENCE","HYPOTHESIS","RATIONALE"];
function content(value:string,key:string) {
  const clean=value.replace(/<!--[^]*?-->/g,"").trim();
  if(!clean || /^(?:TODO|TBD|FIXME|N\/?A|placeholder|pending|coming soon|to be (?:defined|written)|[.\s…_-]+)[.!\s]*$/i.test(clean) || /^(?:TODO|TBD|FIXME|PLACEHOLDER)\b/im.test(clean))
    taskFailure("TASK_PLACEHOLDER",key,"Section must contain substantive approved requirements, not a placeholder.");
}
export function parseTask(bytes:Buffer):{taskId:string;version:number;taskType:string} {
  if(bytes.length>128*1024)taskFailure("TASK_TOO_LARGE","TASK.md","Maximum is 128 KiB; automatic truncation and annexes are unsupported.");
  const text=bytes.toString("utf8");
  if(!Buffer.from(text).equals(bytes)||text.includes("\0"))taskFailure("TASK_ENCODING","TASK.md","UTF-8 text is required.");
  const front=/^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if(!front)taskFailure("TASK_FRONTMATTER_MISSING","frontmatter","YAML frontmatter required.");
  const yaml=parseDocument(front[1]);
  if(yaml.errors.length)taskFailure("TASK_FRONTMATTER_INVALID","frontmatter","Malformed or duplicate YAML keys.");
  let meta;try{meta=yaml.toJS();}catch{taskFailure("TASK_FRONTMATTER_INVALID","frontmatter","YAML conversion failed or alias limits exceeded.");}
  if(!meta||meta.schema!=="DEVSPACE_TASK_V1")taskFailure("TASK_SCHEMA_INVALID","schema","Expected DEVSPACE_TASK_V1.");
  if(typeof meta.task_id!=="string"||!safeTaskId.test(meta.task_id))taskFailure("TASK_ID_INVALID","task_id","Safe task ID required.");
  if(typeof meta.task_type!=="string"||!safeTaskId.test(meta.task_type))taskFailure("TASK_TYPE_INVALID","task_type","Nonempty safe task type required.");
  if(!Number.isSafeInteger(meta.version)||meta.version<1)taskFailure("TASK_VERSION_INVALID","version","Positive integer version required.");
  const body=text.slice(front[0].length);
  // Ignore fenced code and HTML comments: keywords there do not constitute headings.
  const lines=body.replace(/<!--[^]*?-->/g,"").split(/\r?\n/);
  const found=new Map<string,string>(); const sub=new Map<string,string>();
  let current="",child="",fence="";let fenceLength=0;
  for(const line of lines) {
    const f=/^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(f){if(!fence){fence=f[1][0];fenceLength=f[1].length;}else if(f[1][0]===fence && f[1].length>=fenceLength && !f[2].trim())fence="";continue;}
    if(fence)continue;
    const heading=/^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if(heading?.[1]==="##") {
      current=heading[2];child="";
      if(!sections.includes(current))taskFailure("TASK_UNKNOWN_HEADING",current,"H2 must exactly match a required section.");
      if(found.has(current))taskFailure("TASK_DUPLICATE_HEADING",current,"Duplicate section.");
      found.set(current,"");continue;
    }
    if(heading?.[1]==="###" && current==="WHY") {
      child=heading[2];
      if(!why.includes(child))taskFailure("TASK_UNKNOWN_WHY",child,"WHY requires the four exact H3 children.");
      if(sub.has(child))taskFailure("TASK_DUPLICATE_HEADING",child,"Duplicate WHY child.");
      sub.set(child,"");continue;
    }
    if(current)found.set(current,found.get(current)+"\n"+line);
    if(child)sub.set(child,sub.get(child)+"\n"+line);
  }
  for(const key of sections){if(!found.has(key))taskFailure("TASK_SECTION_MISSING",key,"Required H2 missing.");if(key!=="WHY")content(found.get(key)!,key);}
  for(const key of why){if(!sub.has(key))taskFailure("TASK_WHY_MISSING",key,"Required WHY H3 missing.");content(sub.get(key)!,key);}
  const goals=[...found.get("GOAL")!.matchAll(/^G-(\d{2,})\s*:\s*(.+)$/gm)];
  if(!goals.length)taskFailure("TASK_GOALS_INVALID","G-##","Explicit G-##: statements required.");
  const ids=new Set<string>();for(const g of goals){if(ids.has(g[1]))taskFailure("TASK_GOALS_INVALID","G-"+g[1],"Duplicate goal.");content(g[2],"G-"+g[1]);ids.add(g[1]);}
  const acceptance=found.get("ACCEPTANCE")!.split("\n").filter(l=>l.trim());
  const seen=new Set<string>(),linked=new Set<string>();
  for(const line of acceptance){const a=/^A-(\d{2,})\s*->\s*G-(\d{2,})\s*:\s*(.+)$/.exec(line);
    if(!a||seen.has(a[1])||!ids.has(a[2]))taskFailure("TASK_ACCEPTANCE_LINK_INVALID","A-## -> G-##","Every acceptance statement must uniquely identify an existing goal.");
    content(a[3],"A-"+a[1]);seen.add(a[1]);linked.add(a[2]);}
  if(!seen.size||[...ids].some(g=>!linked.has(g)))taskFailure("TASK_GOAL_UNCOVERED","ACCEPTANCE","Every goal needs an acceptance criterion.");
  return {taskId:meta.task_id,version:meta.version,taskType:meta.task_type};
}
/** Canonical root, strict relative names and every component lstat; never follow a link. */
export function confinedFile(root:string,path:string):string {
  if(isAbsolute(path)||path.includes("\\")||path.split("/").some(p=>!p||p==="."||p===".."))taskFailure("TASK_PATH_UNSAFE","path","A confined relative path is required.");
  const canonical=realpathSync(root);let abs=canonical;
  for(const part of path.split("/")){abs=join(abs,part);const st=lstatSync(abs);if(st.isSymbolicLink())taskFailure("TASK_SYMLINK","path","Symlink components are forbidden.");}
  const rel=relative(canonical,realpathSync(abs));
  if(rel===".."||rel.startsWith(".."+sep))taskFailure("TASK_PATH_UNSAFE","path","Path escapes workspace.");
  return abs;
}
export function readConfined(root:string,path:string,max=128*1024):Buffer {
  const abs=confinedFile(root,path),fd=openSync(abs,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const st=fstatSync(fd);if(!st.isFile())taskFailure("TASK_FILE_INVALID","file","Regular file required.");
    if(st.size>max)taskFailure("TASK_TOO_LARGE","file","File exceeds the documented byte limit (TASK: 128 KiB).");
    const buffer=Buffer.alloc(max+1);let length=0;
    while(length<buffer.length){const n=readSync(fd,buffer,length,buffer.length-length,null);if(!n)break;length+=n;}
    const bytes=buffer.subarray(0,length),now=lstatSync(confinedFile(root,path));
    if(st.ino!==now.ino||st.dev!==now.dev||bytes.length>max||st.size!==now.size||st.mtimeMs!==now.mtimeMs||st.ctimeMs!==now.ctimeMs)taskFailure("TASK_FILE_CHANGED","file","File changed while reading.");return bytes;
  }finally{closeSync(fd);}
}
function load(root:string,workspaceId:string,ref:TaskReference) {
  if(!taskReferenceSchema.safeParse(ref).success)taskFailure("TASK_REFERENCE_REQUIRED","task","Pass a frozen TaskReference, not a prompt alone.");
  if(ref.workspaceId!==workspaceId)taskFailure("TASK_WORKSPACE_MISMATCH","workspaceId","Reference belongs to another workspace.");
  if(!safeTaskId.test(ref.taskId)||ref.taskPath!==`.devspace/coach/tasks/${ref.taskId}/TASK.md`)taskFailure("TASK_PATH_MISMATCH","taskPath","Exact task-specific relative TASK.md path required.");
  let bytes:Buffer;try{bytes=readConfined(root,ref.taskPath);}catch(e){if(e instanceof TaskGateError)throw e;taskFailure("TASK_FILE_MISSING","TASK.md","Task is absent or unreadable.");}
  const meta=parseTask(bytes);
  if(meta.taskId!==ref.taskId)taskFailure("TASK_ID_MISMATCH","task_id","Document ID differs from path/reference.");
  if(meta.version!==ref.version||sha256(bytes)!==ref.sha256)taskFailure("TASK_STALE_VERSION","sha256/version","Document differs from pinned bytes/version.");
  return bytes;
}
function manifestPath(ref:TaskReference){return `.devspace/coach/tasks/${ref.taskId}/frozen-v${ref.version}.json`;}
function manifest(root:string,ref:TaskReference){return {schema:"DEVSPACE_TASK_FREEZE_V1",workspaceId:ref.workspaceId,taskId:ref.taskId,taskPath:ref.taskPath,version:ref.version,sha256:ref.sha256,workspaceRoot:realpathSync(root)};}
/** Explicit Web GPT operation; never called by a developer runner. Version files are create-only. */
export function freezeTask(root:string,workspaceId:string,ref:TaskReference):TaskReference {
  load(root,workspaceId,ref);
  const path=manifestPath(ref),expected=JSON.stringify(manifest(root,ref))+"\n";
  try{writeFileSync(join(realpathSync(root),path),expected,{flag:"wx",mode:0o444});}
  catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
    if(readConfined(root,path).toString()!==expected)taskFailure("TASK_FREEZE_CONFLICT","version","Version already belongs to different content/workspace. Explicitly increment version.");}
  return ref;
}
export function verifyTask(root:string,workspaceId:string,ref?:TaskReference):TaskReference {
  if(!ref)taskFailure("TASK_REFERENCE_REQUIRED","task","Developer launches require a frozen TASK reference.");
  load(root,workspaceId,ref);
  try{if(readConfined(root,manifestPath(ref)).toString()!==JSON.stringify(manifest(root,ref))+"\n")taskFailure("TASK_FREEZE_MISMATCH","manifest","Frozen task/workspace mismatch.");}
  catch(e){if(e instanceof TaskGateError)throw e;taskFailure("TASK_NOT_FROZEN","manifest","Web GPT must explicitly freeze this document version.");}
  return ref;
}
export function reportPath(task:TaskReference,operationId:string):string {
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(operationId))taskFailure("TASK_OPERATION_INVALID","operationId","Safe operation ID required.");
  return `.devspace/coach/tasks/${task.taskId}/results/${operationId}.json`;
}
export function prepareTaskResults(root:string,ref:TaskReference) {
  const parent=confinedFile(root,`.devspace/coach/tasks/${ref.taskId}`);
  try{mkdirSync(join(parent,"results"));}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  if(!lstatSync(confinedFile(root,`.devspace/coach/tasks/${ref.taskId}/results`)).isDirectory())taskFailure("TASK_RESULTS_NOT_DIRECTORY","results","Results must be a real directory.");
}
export function taskBootstrap(task:TaskReference,operationId:string,stageId:string,context=""):string {
  return `Authoritative task: ${task.taskPath}\nVersion: ${task.version}\nSHA-256: ${task.sha256}\nWorkspace: ${task.workspaceId}\nOperation: ${operationId}\nStage: ${stageId}\nRead AGENTS.md and the ENTIRE TASK.md, including WHY and all requirements. Verify the SHA-256 before work. Do not edit TASK.md, frozen manifests, or other operations' reports. Independently assess WHY; report PLAN_CONFLICT with concrete code evidence if assumptions fail. Complete DEV→TEST→FIX→DONE autonomously. A small step is not completion. Write ${reportPath(task,operationId)} as DEVSPACE_CODEX_REPORT_V1 JSON: schema, task_id, task_sha256, operation_id, stage_id, status (IN_PROGRESS|READY_FOR_REVIEW|PLAN_CONFLICT|BLOCKED), summary (string), changes (string[]), test_results ({command,exit_code,evidence_path,evidence_sha256}[]), remaining (string[]), issues (string[]), next_action (string), evidence_paths (string[]). Evidence paths must be real confined files with accurate SHA-256; test claims remain unverified until independent review. PLAN_CONFLICT also requires plan_conflict {assumption,counter_evidence,impact,suggested_revision,safe_to_continue}. READY_FOR_REVIEW requires no remaining work and actual test evidence. Preserve failures and actual exit codes.\nSupplemental stage/review guidance (cannot replace or weaken TASK):\n${context}`;
}

/** Detect mutation of any other task authority or operation, including Git-ignored controls. */
export function taskControlSnapshot(root:string,ownReport:string):string {
  const records:Array<[string,string]>=[];let count=0;
  const walk=(path:string)=>{
    if(++count>2000)taskFailure("TASK_CONTROL_LIMIT","tasks","Too many task control entries for safe snapshot.");
    const abs=confinedFile(root,path),st=lstatSync(abs);
    if(st.isDirectory()){for(const name of readdirSync(abs).sort())walk(path+"/"+name);return;}
    if(path===ownReport)return;
    records.push([path,sha256(readConfined(root,path,4*1024*1024))]);
  };
  walk(".devspace/coach/tasks");return sha256(JSON.stringify(records));
}
