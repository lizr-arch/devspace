import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * This program is fixed application source, never user text.
 * The owner pipe is fd 3. It is intentionally NOT passed to the Codex child.
 * When DevSpace is SIGKILLed, its end of fd 3 closes and the guardian kills
 * its OWN private process group (including any Codex descendants).
 */
export const GUARDIAN_SOURCE = [
  "const cp=require('node:child_process'),fs=require('node:fs');",
  "const marker=process.argv[1],cli=process.argv[2],args=process.argv.slice(3);",
  "if(!/^devspace-guardian-[0-9a-f]{36}$/.test(marker)||!cli){process.exit(78)}",
  "let stopping=false,finishing=false;",
  "const stop=()=>{if(stopping)return;stopping=true;",
  "try{process.kill(-process.pid,'SIGKILL')}catch{};",
  "try{process.kill(process.pid,'SIGKILL')}catch{};};",
  "process.on('SIGTERM',()=>{if(!finishing)stop()});",
  "const owner=new (require('node:net').Socket)({fd:3,readable:true,writable:false});",
  "owner.on('end',stop);owner.on('close',stop);owner.on('error',stop);owner.resume();",
  // Do not start ANY Codex work until the parent has stored this guardians
  // identity in native SQLite and explicitly delivered the stdin prompt.
  "const chunks=[];let bytes=0;",
  "process.stdin.on('data',chunk=>{bytes+=chunk.length;",
  "if(bytes>65536)stop();else chunks.push(chunk)});",
  "process.stdin.on('error',stop);",
  "process.stdin.on('end',()=>{if(stopping)return;",
  "const child=cp.spawn(process.execPath,[cli,...args],",
  "{stdio:['pipe','pipe','pipe'],detached:false});",
  "child.stdin.end(Buffer.concat(chunks));",
  "child.stdout.pipe(process.stdout,{end:false});",
  "child.stderr.pipe(process.stderr,{end:false});",
  "child.on('error',stop);",
  // exit fires when Codex itself dies. close can be held open by descendants
  // that inherited stdout/stderr pipes. In that case terminate our own group,
  // verify it is empty of live descendants, then preserve the child exit code.
  "child.on('exit',code=>{if(stopping||finishing)return;finishing=true;",
  "const exitCode=Number.isInteger(code)?code:1;",
  "try{process.kill(-process.pid,'SIGTERM')}catch{stop();return}",
  "setTimeout(()=>{if(stopping)return;",
  "let output;try{output=cp.execFileSync('/bin/ps',['-axo','pid=,pgid=,stat='],",
  "{encoding:'utf8',timeout:2000,maxBuffer:8388608,detached:true})}catch{stop();return}",
  "for(const line of output.split('\\n')){" ,
  "const m=line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(\\S+)$/);",
  "if(!m)continue;if(Number(m[2])===process.pid&&Number(m[1])!==process.pid&&",
  "!m[3].startsWith('Z')){stop();return}}",
  "owner.removeAllListeners();owner.destroy();",
  "process.exit(exitCode)",
  "},350);",
  "});",
  "});",
].join("");

export interface GuardianIdentity {
  marker: string;
  pid: number;
  pgid: number;
  uid: number;
  lstart: string;
}
export interface GuardianProbe {
  pid: number;
  pgid: number;
  uid: number;
  lstart: string;
  command: string;
}
export type GuardianAssessment =
  | { kind: "alive"; groupMembers: number[] }
  | { kind: "gone"; groupMembers: [] }
  | { kind: "unknown"; reason: string; groupMembers: number[] };

const MARKER=/^devspace-guardian-[a-f0-9]{36}$/;
const LSTART=/^\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;

/** Snapshot one PID using the OS, without sending any signal. Darwin only. */
function ps(pid:number):GuardianProbe|undefined {
  if(process.platform!=="darwin"||!Number.isSafeInteger(pid)||pid<=1)return undefined;
  let output:string;
  try{
    output=execFileSync("/bin/ps",["-wwp",String(pid),"-o",
      "pid=,pgid=,uid=,lstart=,command="],{
      encoding:"utf8",timeout:1800,maxBuffer:65536,
      stdio:["ignore","pipe","ignore"],
    }).trim();
  }catch{return undefined;}
  const match=output.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+([\s\S]*)$/);
  if(!match)return undefined;
  const result={pid:Number(match[1]),pgid:Number(match[2]),uid:Number(match[3]),
    lstart:match[4].replace(/\s+/g," "),command:match[5]};
  return LSTART.test(result.lstart)?result:undefined;
}
/** Read process ownership data without signalling the PID (macOS only). */
export function inspectProcessIdentity(pid:number):GuardianProbe|undefined { return ps(pid); }
export function createGuardianMarker():string{
  return "devspace-guardian-"+randomBytes(18).toString("hex");
}
/** Called by the parent just after spawn, then committed to native SQLite. */
export function readGuardianIdentity(
  pid:number,marker:string,uid=process.getuid?.()??-1,
):GuardianIdentity|undefined {
  if(!MARKER.test(marker))return undefined;
  const found=ps(pid);
  if(!found||found.pid!==pid||found.pgid!==pid||found.uid!==uid||
     !found.command.includes(marker))return undefined;
  return {marker,pid,pgid:found.pgid,uid,lstart:found.lstart};
}
/** Exact group membership is read-only. Unknown ps outputs block clearance. */
function membersOfGroup(pgid:number):number[]|undefined{
  if(process.platform!=="darwin"||!Number.isSafeInteger(pgid)||pgid<=1)return undefined;
  let output:string;
  try{
    output=execFileSync("/bin/ps",["-axo","pid=,pgid=,uid=,stat="],{
      encoding:"utf8",timeout:2200,maxBuffer:8*1024*1024,
      stdio:["ignore","pipe","ignore"],
    });
  }catch{return undefined;}
  const pids:number[]=[];
  for(const line of output.split("\n")){
    if(!line.trim())continue;
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
    if(!m)return undefined;
    if(Number(m[2])!==pgid || m[4].startsWith("Z"))continue;
    pids.push(Number(m[1]));
  }
  return pids;
}
export function assessGuardian(identity:GuardianIdentity):GuardianAssessment {
  if(!identity||!MARKER.test(identity.marker)||
     !Number.isSafeInteger(identity.pid)||identity.pid<=1||
     identity.pid!==identity.pgid || identity.uid!==(process.getuid?.()??-1)||
     !LSTART.test(identity.lstart))return {kind:"unknown",reason:"invalid_identity",groupMembers:[]};
  const members=membersOfGroup(identity.pgid);
  if(!members)return {kind:"unknown",reason:"os_group_inspection_failed",groupMembers:[]};
  const candidate=ps(identity.pid);
  if(candidate){
    if(candidate.pid!==identity.pid||candidate.uid!==identity.uid||
       candidate.pgid!==identity.pgid||candidate.lstart!==identity.lstart||
       !candidate.command.includes(identity.marker))
      return {kind:"unknown",reason:"pid_reused_or_identity_changed",groupMembers:members};
    return {kind:"alive",groupMembers:members};
  }
  if(members.length)return {kind:"unknown",reason:"orphan_group_members_remain",groupMembers:members};
  return {kind:"gone",groupMembers:[]};
}
/** Never kills an unknown or old PID. Authorization belongs to the caller. */
export function guardedClearQuarantine(identity:GuardianIdentity):{
  cleared:boolean;reason:string;
}{
  const assessed=assessGuardian(identity);
  return assessed.kind==="gone"
    ? {cleared:true,reason:"verified_guardian_and_group_absent"}
    : {cleared:false,reason:assessed.kind==="alive"?"guardian_still_running":assessed.reason};
}
