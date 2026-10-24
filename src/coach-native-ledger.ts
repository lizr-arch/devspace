/**
 * ONEPASS-003-NATIVE-TX-004 M1 / G5: cross-process operation ledger.
 * O_EXCL create per (workspaceId, operationId), atomic 0600 temp+rename writes,
 * monotonic state transitions (never downgrade COMPLETED/REPLY_VERIFIED).
 * A second process with the same operationId must never reach the CLI; it gets
 * `claimed:false` and the existing receipt instead.
 */
import {randomBytes} from "node:crypto";
import {closeSync,existsSync,mkdirSync,openSync,renameSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {
 type LedgerRecord,
 type NativeOutboundReceipt,
 type NativeOutboundState,
 RANK,
 assertValidOperation,
 errnoCode,
 fail,
 sha256Hex,
} from "./coach-native-outbound-types.js";
import {REAL_RUNTIME} from "./coach-native-daemon.js";

/* ------------------------------------------------------------------ *
 * G5: cross-process ledger
 * ------------------------------------------------------------------ */

export const TERMINAL_STATES:ReadonlySet<NativeOutboundState>=new Set(["COMPLETED","REPLY_VERIFIED","UNCERTAIN","BLOCKED"]);

function ledgerDir(stateDir:string):string{
 return join(stateDir,"native-outbound");
}

function ledgerKey(workspaceId:string,operationId:string):string{
 return sha256Hex(workspaceId+"\0"+operationId);
}

function ledgerPathFor(stateDir:string,workspaceId:string,operationId:string):string{
 return join(ledgerDir(stateDir),ledgerKey(workspaceId,operationId)+".json");
}

/** Ensure the ledger directory itself is a real, private, non-symlink directory. */
function ensureLedgerDir(stateDir:string):string{
 const runtime=REAL_RUNTIME;
 const directory=ledgerDir(stateDir);
 if(!existsSync(directory))mkdirSync(directory,{recursive:true,mode:0o700});
 const stat=runtime.lstat(directory);
 if(stat.isSymbolicLink()||!stat.isDirectory())fail("LEDGER_DIR_UNSAFE","ledger directory must be a real directory");
 const uid=runtime.uid;
 if(stat.uid!==uid)fail("LEDGER_DIR_UNSAFE","ledger directory owned by another uid");
 if((stat.mode&0o077)!==0)fail("LEDGER_DIR_UNSAFE","ledger directory is not private to this uid");
 return directory;
}

function parseLedger(raw:string,workspaceId:string,operationId:string):LedgerRecord{
 let parsed:unknown;
 try{parsed=JSON.parse(raw);}catch{return fail("LEDGER_INVALID","ledger file is not JSON");}
 if(!parsed||typeof parsed!=="object")fail("LEDGER_INVALID","ledger file is not an object");
 const receipt=parsed as Record<string,unknown>;
 if(receipt.workspaceId!==workspaceId||receipt.operationId!==operationId)
  fail("LEDGER_INVALID","ledger does not belong to this workspace/operation");
 if(typeof receipt.state!=="string"||!(receipt.state in {...RANK,UNCERTAIN:9,BLOCKED:9}))
  fail("LEDGER_INVALID","ledger state is invalid");
 if(typeof receipt.fingerprint!=="string"||!receipt.fingerprint)fail("LEDGER_INVALID","ledger fingerprint missing");
 return receipt as unknown as LedgerRecord;
}

function readLedgerRecord(stateDir:string,workspaceId:string,operationId:string):LedgerRecord|undefined{
 const path=ledgerPathFor(stateDir,workspaceId,operationId);
 let raw:string;
 try{raw=REAL_RUNTIME.readText(path);}catch(error){
  if(errnoCode(error)==="ENOENT")return undefined;
  return fail("LEDGER_UNREADABLE","ledger unreadable");
 }
 return parseLedger(raw,workspaceId,operationId);
}

/**
 * G5: atomically claim operationId for exactly one process via O_EXCL. A second
 * caller gets `claimed:false` plus the existing receipt; it must never invoke
 * the CLI. Same fingerprint + completed state is the same logical operation.
 */
export function claimOperation(
 stateDir:string,
 workspaceId:string,
 operationId:string,
 fingerprint:string,
):{claimed:true;ledgerPath:string}|{claimed:false;existing:NativeOutboundReceipt}{
 assertValidOperation(workspaceId,operationId);
 if(typeof fingerprint!=="string"||!fingerprint)fail("FINGERPRINT_INVALID","fingerprint must be a non-empty string");
 const directory=ensureLedgerDir(stateDir);
 const path=ledgerPathFor(stateDir,workspaceId,operationId);
 const now=REAL_RUNTIME.now();
 const record:LedgerRecord={
  state:"PRESEND",workspaceId,operationId,threadId:"",payloadSha256:"",
  fingerprint,createdAt:now,updatedAt:now,
 };
 let fd:number;
 try{
  fd=openSync(path,"wx",0o600);
 }catch(error){
  if(errnoCode(error)!=="EEXIST")return fail("LEDGER_UNWRITABLE","cannot create ledger");
  const existing=readLedgerRecord(stateDir,workspaceId,operationId);
  if(!existing)return fail("LEDGER_RACE","ledger disappeared during claim");
  return {claimed:false,existing:existing as NativeOutboundReceipt};
 }
 try{writeFileSync(fd,JSON.stringify(record),{mode:0o600});}
 finally{closeSync(fd);}
 void directory;
 return {claimed:true,ledgerPath:path};
}

export function readNativeOutboundReceipt(
 stateDir:string,
 workspaceId:string,
 operationId:string,
):NativeOutboundReceipt|undefined{
 assertValidOperation(workspaceId,operationId);
 const record=readLedgerRecord(stateDir,workspaceId,operationId);
 return record?record as NativeOutboundReceipt:undefined;
}

function writeLedger(stateDir:string,workspaceId:string,operationId:string,patch:Partial<LedgerRecord>,options:{allowTerminal?:boolean}={}):LedgerRecord{
 const path=ledgerPathFor(stateDir,workspaceId,operationId);
 const existing=readLedgerRecord(stateDir,workspaceId,operationId);
 if(!existing)fail("LEDGER_MISSING","ledger missing before write");
 const next=patch.state;
 if(next&&existing.state){
  const currentRank=RANK[existing.state];
  const nextRank=RANK[next];
  const isTerminal=next==="UNCERTAIN"||next==="BLOCKED";
  const allowed=nextRank!==undefined
   ?(currentRank===undefined||nextRank>currentRank)
   :(isTerminal&&(options.allowTerminal??true)&&currentRank!==undefined&&currentRank<2);
  if(!allowed&&next!==existing.state)return existing;
 }else if(!next&&existing.state){
  // pure field update: keep state, still monotonic (never downgrade).
 }
 const merged:LedgerRecord={...existing,...patch,updatedAt:REAL_RUNTIME.now()};
 if(patch.state===undefined)merged.state=existing.state;
 const temp=join(dirname(path),"."+randomBytes(8).toString("hex")+".tmp");
 writeFileSync(temp,JSON.stringify(merged),{mode:0o600});
 renameSync(temp,path);
 return merged;
}

export {readLedgerRecord,writeLedger};
