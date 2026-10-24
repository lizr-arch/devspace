/**
 * ONEPASS-003-NATIVE-TX-004 M1: shared types, constants and validation helpers
 * for the native Codex App outbound delivery core (ROLE-005 split).
 *
 * No side effects beyond hashing/env lookup; imported by every other
 * coach-native-* module and re-exported from coach-native-outbound.ts.
 */
import {createHash} from "node:crypto";
import {homedir} from "node:os";
import {join} from "node:path";
import {APP_THREAD_ID} from "./coach-app-server-bridge.js";

/* ------------------------------------------------------------------ *
 * Public state / receipt / error types (API fixed by task-9)
 * ------------------------------------------------------------------ */

export type NativeOutboundState =
 | "PRESEND" | "ACCEPTED" | "TURN_OBSERVED" | "COMPLETED" | "REPLY_VERIFIED" | "UNCERTAIN" | "BLOCKED";

export interface NativeOutboundReceipt {
 state:NativeOutboundState;
 workspaceId:string;
 operationId:string;
 threadId:string;
 payloadSha256:string;
 createdAt:number;
 updatedAt:number;
 queueMessageId?:string;
 queueExitCode?:number;
 turnId?:string;
 userItemId?:string;
 reply?:string;
 replySha256?:string;
 error?:string;
 uncertaintyReason?:string;
 /** P0 diagnostics for UNCERTAIN queue/CLI outcomes (safe, non-sensitive). */
 queueDiagnostic?:QueueRunDiagnostic;
 /** Pre-send baseline of deliveries matching payloadSha256 (for durable reconcile). */
 preObservedTurnIds?:string[];
 preObservedItemIds?:string[];
 /** Exact rollout root persisted at send time, so read-only reconcile can re-verify cwd. */
 workspaceRoot?:string;
 sandbox?:NativeOutboundSandbox;
 /** Coach review event id once a REPLY_VERIFIED receipt was published (idempotency). */
 reviewEventId?:string;
}

/** Frozen TASK reference accepted by native_send/native_rework continuity. */
export interface NativeOutboundTaskReference {
 taskPath:string;
 taskId:string;
 sha256:string;
 version?:number;
 workspaceId?:string;
}
export type NativeOutboundSandbox="read-only"|"workspace-write";
export const TASK_SHA256=/^[a-f0-9]{64}$/;
export function assertValidNativeTask(task:NativeOutboundTaskReference):void{
 if(!task||typeof task!=="object")fail("TASK_REFERENCE_INVALID","task reference must be an object");
 if(typeof task.taskPath!=="string"||!task.taskPath.trim())fail("TASK_REFERENCE_INVALID","task.taskPath is required");
 if(typeof task.taskId!=="string"||!WORKSPACE_ID.test(task.taskId))fail("TASK_REFERENCE_INVALID","task.taskId is invalid");
 if(typeof task.sha256!=="string"||!TASK_SHA256.test(task.sha256))fail("TASK_REFERENCE_INVALID","task.sha256 must be 64 lowercase hex");
}
export function assertValidSandbox(sandbox:unknown):asserts sandbox is NativeOutboundSandbox{
 if(sandbox!=="read-only"&&sandbox!=="workspace-write")fail("SANDBOX_INVALID","sandbox must be read-only or workspace-write");
}
/** Journal task identity: real frozen TASK when provided, explicit read-only otherwise. */
export function nativeJournalTaskFields(task?:NativeOutboundTaskReference):{taskId:string;taskSha256:string}{
 if(!task)return {taskId:"read-only",taskSha256:sha256Hex("read-only")};
 assertValidNativeTask(task);
 return {taskId:task.taskId,taskSha256:task.sha256};
}

export class NativeOutboundError extends Error {
 readonly code:string;
 constructor(code:string,message?:string){
  super(message??code);
  this.name="NativeOutboundError";
  this.code=code;
 }
}

export interface ManagedDaemonIdentity {
 pid:number;
 version:string;
 executable:string;
 socketPath:string;
 socketRealpath:string;
 codexHome:string;
 bootId:string;
 startSeconds:number;
}

/* ------------------------------------------------------------------ *
 * Injectable runtime (tests replace this; production uses the real impl)
 * ------------------------------------------------------------------ */

export interface ManagedProcessInfo {
 pid:number;
 ppid:number;
 uid:number;
 cmd:string;
 comm:string;
}

export interface FileStatLike {
 isSymbolicLink():boolean;
 isFile():boolean;
 isDirectory():boolean;
 isSocket():boolean;
 uid:number;
 mode:number;
 size:number;
 mtimeMs:number;
}

export interface QueueRunDiagnostic {
 /** Safe classification of a queue-CLI failure (no prompt/argv/env/contents). */
 classification:
  |"QUEUE_TIMEOUT"
  |"QUEUE_SIGNALLED"
  |"QUEUE_BINARY_NOT_FOUND"
  |"QUEUE_BINARY_UNEXECUTABLE"
  |"SPAWN_ERROR"
  |"QUEUE_NULL_STATUS";
 status:number|null;
 signal:string|null;
 timedOut:boolean;
 errnoCode:string|null;
 elapsedMs:number|null;
 stdoutBytes:number;
 stderrBytes:number;
 /** Non-sensitive binary provenance (basename + size/mtime), no absolute path. */
 codexBinary?:{name:string;size:number|null;mtimeMs:number|null};
}

export interface QueueRunResult {
 code:number|null;
 stdout:string;
 stderr:string;
 /** "TIMEOUT" when the CLI did not finish inside the configured timeout. */
 error?:string;
 /** Process fate evidence (never contains command lines or file contents). */
 signal?:string|null;
 errnoCode?:string|null;
 timedOut?:boolean;
 elapsedMs?:number;
 stdoutBytes?:number;
 stderrBytes?:number;
 codexBinary?:{name:string;size:number|null;mtimeMs:number|null};
}

export interface NativeOutboundRuntime {
 uid:number;
 listProcesses():ManagedProcessInfo[];
 lockOwnerPids(lockPath:string):number[];
 lsofTextPaths(pid:number):string[];
 readText(path:string):string;
 lstat(path:string):FileStatLike;
 readlink(path:string):string;
 realpath(path:string):string;
 statFile(path:string):{size:number;mtimeMs:number};
 probeWebSocket(socketPath:string):Promise<boolean>;
 runQueue(input:{codexBin:string;argv:string[];env:Record<string,string|undefined>;timeoutMs:number}):QueueRunResult;
 findRollout(threadId:string,codexHome:string):string;
 readRolloutText(path:string):string;
 sleep(ms:number):Promise<void>;
 now():number;
}

export interface NativeOutboundDeps {
 codexHome?:string;
 socketPath?:string;
 codexBin?:string;
 timeoutMs?:number;
 observeTimeoutMs?:number;
 pollMs?:number;
 runtime?:Partial<NativeOutboundRuntime>;
 /** High-level test seams; production leaves these undefined. */
 inspectDaemon?:(opts:{codexHome:string;socketPath:string})=>Promise<ManagedDaemonIdentity>;
 verifyOwnership?:(input:{threadId:string;root:string;codexHome:string;socketPath:string})=>{threadId:string;root:string;status:string};
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

export const MAX_PROMPT=10_000;
const OPERATION_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const WORKSPACE_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const MAIN_BIN="/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
export const RANK:Record<string,number>={PRESEND:0,ACCEPTED:1,TURN_OBSERVED:2,COMPLETED:3,REPLY_VERIFIED:4};

export function sha256Hex(value:string|Buffer):string{
 return createHash("sha256").update(value).digest("hex");
}

export function defaultCodexHome():string{
 return process.env.CODEX_HOME??join(homedir(),".codex");
}

export function fail(code:string,message?:string):never{
 throw new NativeOutboundError(code,message);
}

export function errnoCode(error:unknown):string|undefined{
 return (error as NodeJS.ErrnoException|undefined)?.code;
}

export function assertValidOperation(workspaceId:string,operationId:string):void{
 if(!WORKSPACE_ID.test(workspaceId))fail("WORKSPACE_ID_INVALID","invalid workspaceId");
 if(!OPERATION_ID.test(operationId))fail("OPERATION_ID_INVALID","invalid operationId");
}

export function assertValidThread(threadId:string):void{
 if(!APP_THREAD_ID.test(threadId))fail("THREAD_ID_INVALID","thread id must be a canonical UUID");
}

export function realpathOrThrow(runtime:NativeOutboundRuntime,path:string,code:string):string{
 try{return runtime.realpath(path);}catch{return fail(code,"cannot resolve "+path);}
}

export interface NativeOutboundQueueCommand {
 codexBin:string;
 argv:string[];
 env:Record<string,string|undefined>;
}

export interface LedgerRecord extends NativeOutboundReceipt {
 fingerprint:string;
}

export function asDeps(value:unknown):NativeOutboundDeps{
 if(value&&typeof value==="object")return value as NativeOutboundDeps;
 return {};
}
