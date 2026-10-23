/**
 * Shared, App-visible Codex session transport. Connect to the *existing* local
 * Codex App Server over its private Unix socket. Never launch another server,
 * never edit ~/.codex history, and never steal a separate server's writer lock.
 */
import { connect, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { lstatSync, statSync, realpathSync, mkdirSync, readFileSync, openSync, closeSync, writeFileSync, renameSync } from "node:fs";

export const APP_THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_FRAME = 2_097_152;
const MAX_REPLY = 16_384;
const MAX_PROMPT = 10_000;
export const defaultSharedSocket = () => join(homedir(), ".codex", "app-server-control", "app-server-control.sock");

export class AppBridgeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AppBridgeError"; }
}
export function checkSharedSocket(path = defaultSharedSocket()): void {
  try {
    const alias=lstatSync(path);
    const uid=process.getuid?.();
    if (uid===undefined || alias.uid!==uid)throw new AppBridgeError("CODEX_APP_SOCKET_UNSAFE");
    if (alias.isSymbolicLink()) {
      // Codex 0.162.1 uses a symlink into a private, per-UID daemon directory.
      // All other symlink destinations fail closed.
      if(process.platform!=="darwin")throw new AppBridgeError("CODEX_APP_SOCKET_UNSAFE");
      const target=realpathSync(path),folder=dirname(target);
      if(folder!=="/private/tmp/codex-daemon-"+uid ||
         !/^[a-f0-9]{64}$/.test(basename(target)))
        throw new AppBridgeError("CODEX_APP_SOCKET_UNSAFE");
      const parent=statSync(folder);
      if(parent.uid!==uid || (parent.mode&0o077)!==0 || !parent.isDirectory())
        throw new AppBridgeError("CODEX_APP_SOCKET_UNSAFE");
    } else if(!alias.isSocket())throw new AppBridgeError("CODEX_APP_SOCKET_UNSAFE");
    const info=statSync(path);
    if(!info.isSocket()||info.uid!==uid||(info.mode&0o077)!==0)
      throw new AppBridgeError("CODEX_APP_SOCKET_UNSAFE");
  } catch (error) {
    if (error instanceof AppBridgeError) throw error;
    throw new AppBridgeError("CODEX_APP_SHARED_SOCKET_UNAVAILABLE");
  }
}
function safeRoot(root: string): string { return realpathSync(root); }
function assertThread(thread: unknown, expectedRoot: string, expectedId?: string): asserts thread is Record<string, unknown> {
  if (!thread || typeof thread !== "object") throw new AppBridgeError("CODEX_APP_THREAD_MISSING");
  const t = thread as Record<string,unknown>;
  if (expectedId && t.id !== expectedId) throw new AppBridgeError("CODEX_APP_THREAD_MISMATCH");
  if (typeof t.cwd !== "string" || safeRoot(t.cwd) !== safeRoot(expectedRoot))
    throw new AppBridgeError("CODEX_APP_THREAD_WORKSPACE_MISMATCH");
  if (t.ephemeral === true) throw new AppBridgeError("CODEX_APP_THREAD_NOT_DURABLE");
  if (t.source !== "vscode") throw new AppBridgeError("CODEX_APP_THREAD_NOT_APP_VISIBLE");
}

export interface SharedMessage { method?:string; id?:number; result?:any; error?:any; params?:any }
export class SharedAppConnection {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private ready = false;
  private closed = false;
  private counter = 0;
  private pending = new Map<number,{resolve:(r:any)=>void;reject:(e:Error)=>void}>();
  private listeners = new Set<(msg:SharedMessage)=>void>();
  private connectResolve?: () => void;
  private connectReject?: (e:Error) => void;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly socketPath = defaultSharedSocket()) {}

  async open(timeoutMs=12000): Promise<void> {
    if (this.socket) throw new AppBridgeError("CODEX_APP_ALREADY_CONNECTED");
    checkSharedSocket(this.socketPath);
    const key = randomBytes(16).toString("base64");
    await new Promise<void>((resolveOpen,rejectOpen)=>{
      this.connectResolve=resolveOpen; this.connectReject=rejectOpen;
      this.handshakeTimer=setTimeout(()=>this.fail(new AppBridgeError("CODEX_APP_HANDSHAKE_TIMEOUT")),timeoutMs);
      const s=connect(this.socketPath);
      this.socket=s;
      s.on("connect",()=>s.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"+
        "Sec-WebSocket-Key: "+key+"\r\nSec-WebSocket-Version: 13\r\n\r\n"));
      s.on("data",chunk=>this.consume(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
      s.on("error",()=>this.fail(new AppBridgeError("CODEX_APP_SOCKET_ERROR")));
      s.on("close",()=>this.fail(new AppBridgeError("CODEX_APP_SOCKET_CLOSED")));
    });
    const init=await this.request("initialize",{
      clientInfo:{name:"devspace-coach-shared",title:"DevSpace Coach Shared App",version:"1.0.0"},
      capabilities:{experimentalApi:false}
    },timeoutMs);
    if (typeof init?.platformOs!=="string") throw new AppBridgeError("CODEX_APP_INITIALIZE_INVALID");
    this.notify("initialized");
  }

  private consume(data:Buffer): void {
    if (this.closed) return;
    this.buffer=Buffer.concat([this.buffer,data]);
    if (this.buffer.length>MAX_FRAME+1024) {this.fail(new AppBridgeError("CODEX_APP_BUFFER_LIMIT"));return;}
    if (!this.ready) {
      const end=this.buffer.indexOf("\r\n\r\n");
      if (end<0) return;
      const header=this.buffer.subarray(0,end).toString("ascii");
      if (!/^HTTP\/1\.[01] 101(?:\s|$)/.test(header.split("\r\n")[0])) {
        this.fail(new AppBridgeError("CODEX_APP_HANDSHAKE_REJECTED"));return;
      }
      this.buffer=this.buffer.subarray(end+4);
      this.ready=true;
      if(this.handshakeTimer)clearTimeout(this.handshakeTimer);
      this.connectResolve?.();
    }
    while(this.buffer.length>=2&&!this.closed) {
      const opcode=this.buffer[0]&15;
      let length=this.buffer[1]&127, offset=2;
      if(length===126){if(this.buffer.length<4)return;length=this.buffer.readUInt16BE(2);offset=4;}
      else if(length===127){if(this.buffer.length<10)return;const big=this.buffer.readBigUInt64BE(2);
        if(big>BigInt(MAX_FRAME)){this.fail(new AppBridgeError("CODEX_APP_FRAME_LIMIT"));return;}
        length=Number(big);offset=10;
      }
      if(length>MAX_FRAME){this.fail(new AppBridgeError("CODEX_APP_FRAME_LIMIT"));return;}
      const masked=!!(this.buffer[1]&0x80);
      const total=offset+(masked?4:0)+length;
      if(this.buffer.length<total)return;
      const bytes=Buffer.from(this.buffer.subarray(offset+(masked?4:0),total));
      if(masked){const mask=this.buffer.subarray(offset,offset+4);
        for(let i=0;i<bytes.length;i++)bytes[i]^mask[i%4];}
      this.buffer=this.buffer.subarray(total);
      if(opcode===8){this.fail(new AppBridgeError("CODEX_APP_SERVER_CLOSED"));return;}
      if(opcode===9){this.frame(bytes,0xA);continue;}
      if(opcode!==1)continue;
      let msg:SharedMessage;
      try{msg=JSON.parse(bytes.toString("utf8")) as SharedMessage;}
      catch{this.fail(new AppBridgeError("CODEX_APP_MALFORMED_EVENT"));return;}
      if(typeof msg.id==="number"&&this.pending.has(msg.id)){
        const p=this.pending.get(msg.id)!;this.pending.delete(msg.id);
        if(msg.error)p.reject(new AppBridgeError("CODEX_APP_RPC_REJECTED:"+String(msg.error?.message||"unknown").slice(0,150)));
        else p.resolve(msg.result);
      }else{
        for(const cb of this.listeners)cb(msg);
      }
    }
  }

  private frame(body:Buffer,opcode=1):void {
    if(!this.socket||!this.ready||this.closed)throw new AppBridgeError("CODEX_APP_NOT_CONNECTED");
    if(body.length>MAX_FRAME)throw new AppBridgeError("CODEX_APP_FRAME_LIMIT");
    const mask=randomBytes(4),n=body.length;
    let header:Buffer;
    if(n<126)header=Buffer.from([0x80|opcode,0x80|n]);
    else if(n<65536){header=Buffer.alloc(4);header[0]=0x80|opcode;header[1]=0xfe;header.writeUInt16BE(n,2);}
    else{header=Buffer.alloc(10);header[0]=0x80|opcode;header[1]=0xff;header.writeBigUInt64BE(BigInt(n),2);}
    const encoded=Buffer.alloc(n);for(let i=0;i<n;i++)encoded[i]=body[i]^mask[i%4];
    this.socket.write(Buffer.concat([header,mask,encoded]));
  }
  private notify(method:string,params:Record<string,unknown>={}):void {
    this.frame(Buffer.from(JSON.stringify({method,params}),"utf8"));
  }
  request(method:string,params:Record<string,unknown>,timeoutMs=15000):Promise<any> {
    const id=++this.counter;
    return new Promise((resolvePromise,rejectPromise)=>{
      let settled=false;
      const timer=setTimeout(()=>{const found=this.pending.get(id);
        if(found){this.pending.delete(id);found.reject(new AppBridgeError("CODEX_APP_RPC_TIMEOUT"));}},timeoutMs);
      this.pending.set(id,{resolve:r=>{if(!settled){settled=true;clearTimeout(timer);resolvePromise(r);}},
        reject:e=>{if(!settled){settled=true;clearTimeout(timer);rejectPromise(e);}}});
      try{this.frame(Buffer.from(JSON.stringify({id,method,params}),"utf8"));}
      catch(e){this.pending.delete(id);clearTimeout(timer);rejectPromise(e);}
    });
  }
  observe(listener:(msg:SharedMessage)=>void):()=>void {
    this.listeners.add(listener);return()=>this.listeners.delete(listener);
  }
  close():void {this.fail(new AppBridgeError("CODEX_APP_DISCONNECTED"));}
  private fail(error:Error):void {
    if(this.closed)return;this.closed=true;
    if(this.handshakeTimer)clearTimeout(this.handshakeTimer);
    this.connectReject?.(error);
    for(const p of this.pending.values())p.reject(error);
    this.pending.clear();this.listeners.clear();this.socket?.destroy();
  }
}

const inProcess = new Map<string,Promise<unknown>>();
function serial<T>(key:string, action:()=>Promise<T>):Promise<T>{
  const prior=inProcess.get(key)??Promise.resolve();
  const current=prior.catch(()=>undefined).then(action);
  inProcess.set(key,current);
  void current.finally(()=>{if(inProcess.get(key)===current)inProcess.delete(key);}).catch(()=>undefined);
  return current;
}
async function withConnection<T>(socketPath:string|undefined,fn:(conn:SharedAppConnection)=>Promise<T>):Promise<T>{
  const connection=new SharedAppConnection(socketPath);
  try{await connection.open();return await fn(connection);}finally{connection.close();}
}
export interface ThreadInfo { threadId:string; source:string; cwd:string; turns:number; status?:string }
export async function sharedAppStatus(socketPath?:string):Promise<{connected:boolean;error?:string}>{
  try{await withConnection(socketPath,async()=>undefined);return{connected:true};}
  catch(error){return{connected:false,error:error instanceof AppBridgeError?error.code:"CODEX_APP_UNAVAILABLE"};}
}
export async function readSharedThread(input:{root:string;threadId:string;socketPath?:string;limit?:number}):Promise<{thread:ThreadInfo;historyAvailable:boolean;messages:Array<{role:"user"|"assistant";text:string}>}>{
  if(!APP_THREAD_ID.test(input.threadId))throw new AppBridgeError("CODEX_APP_THREAD_ID_INVALID");
  return withConnection(input.socketPath,async c=>{
    let data:any,historyAvailable=true;
    try {data=await c.request("thread/read",{threadId:input.threadId,includeTurns:true});}
    catch(e){
      if(!(e instanceof AppBridgeError&&e.code.includes("list_turns is not supported yet")))throw e;
      historyAvailable=false;
      data=await c.request("thread/read",{threadId:input.threadId,includeTurns:false});
    }
    const thread=data?.thread;
    assertThread(thread,input.root,input.threadId);
    const turns=Array.isArray(thread.turns)?thread.turns:[];
    const messages:Array<{role:"user"|"assistant";text:string}>=[];
    for(const turn of turns)for(const item of Array.isArray(turn.items)?turn.items:[]){
      if(item.type==="userMessage"){
        const t=(Array.isArray(item.content)?item.content:[]).filter((v:any)=>v.type==="text").map((v:any)=>String(v.text||"")).join("\n");
        if(t)messages.push({role:"user",text:t.slice(0,MAX_REPLY)});
      }else if(item.type==="agentMessage"&&item.text){
        messages.push({role:"assistant",text:String(item.text).slice(0,MAX_REPLY)});
      }
    }
    return{thread:{threadId:thread.id as string,source:"vscode",cwd:thread.cwd as string,turns:turns.length,status:(thread.status as {type?:string}|undefined)?.type},
      historyAvailable,messages:messages.slice(-(input.limit??8))};
  });
}
export async function createSharedThread(input:{root:string;socketPath?:string}):Promise<ThreadInfo>{
  return withConnection(input.socketPath,async c=>{
    const res=await c.request("thread/start",{cwd:safeRoot(input.root),sandbox:"read-only",approvalPolicy:"never",ephemeral:false});
    const t=res?.thread;assertThread(t,input.root);
    if(typeof t.id!=="string"||!APP_THREAD_ID.test(t.id))throw new AppBridgeError("CODEX_APP_THREAD_ID_INVALID");
    return{threadId:t.id,source:"vscode",cwd:t.cwd as string,turns:0,status:(t.status as {type?:string}|undefined)?.type};
  });
}

function bindingPath(stateDir:string,workspaceId:string):string {
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(workspaceId))
    throw new AppBridgeError("CODEX_APP_WORKSPACE_ID_INVALID");
  return join(stateDir,"coach-app-thread-bindings",
    createHash("sha256").update(workspaceId).digest("hex")+".json");
}
export function boundSharedThread(stateDir:string,workspaceId:string):string|undefined {
  const path=bindingPath(stateDir,workspaceId);
  try {
    const raw=JSON.parse(readFileSync(path,"utf8")) as {workspaceId:string;threadId:string};
    if(raw.workspaceId!==workspaceId||!APP_THREAD_ID.test(raw.threadId))
      throw new AppBridgeError("CODEX_APP_BINDING_INVALID");
    return raw.threadId;
  }catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;
    if(error instanceof AppBridgeError)throw error;
    throw new AppBridgeError("CODEX_APP_BINDING_UNREADABLE");
  }
}
/** The result of a previously submitted operation, safe to query after a client timeout. */
export function sharedTurnReceipt(stateDir:string,workspaceId:string,operationId:string):
  {state:"PENDING"|"UNCERTAIN"|"COMPLETED";receipt?:TurnReceipt}|undefined {
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(workspaceId)||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(operationId))
    throw new AppBridgeError("CODEX_APP_OPERATION_ID_INVALID");
  const key=createHash("sha256").update(workspaceId+"\0"+operationId).digest("hex");
  try{
    const raw=JSON.parse(readFileSync(join(stateDir,"coach-app-turns",key+".json"),"utf8")) as
      {workspaceId:string;state:"PENDING"|"UNCERTAIN"|"COMPLETED";receipt?:TurnReceipt};
    if(raw.workspaceId!==workspaceId||!["PENDING","UNCERTAIN","COMPLETED"].includes(raw.state))
      throw new AppBridgeError("CODEX_APP_RECEIPT_INVALID");
    return {state:raw.state,...(raw.receipt?{receipt:raw.receipt}:{})};
  }catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")return undefined;
    if(e instanceof AppBridgeError)throw e;
    throw new AppBridgeError("CODEX_APP_RECEIPT_UNREADABLE");
  }
}
/** Exact workspace-to-thread pin. Never guesses a ChatGPT tab or silently rebinds. */
export async function bindSharedThread(input:{workspaceId:string;root:string;threadId:string;stateDir:string;socketPath?:string}):Promise<string> {
  if(!APP_THREAD_ID.test(input.threadId))throw new AppBridgeError("CODEX_APP_THREAD_ID_INVALID");
  // Verify ownership on the real live app service before persisting.
  await readSharedThread({...input,limit:1});
  const existing=boundSharedThread(input.stateDir,input.workspaceId);
  if(existing){
    if(existing!==input.threadId)throw new AppBridgeError("CODEX_APP_WORKSPACE_ALREADY_BOUND");
    return existing;
  }
  // One thread must not be owned by two Web GPT workspaces, even if both
  // happen to point at the same physical checkout.
  const ownerDir=join(input.stateDir,"coach-app-thread-owners");
  mkdirSync(ownerDir,{recursive:true,mode:0o700});
  const ownerPath=join(ownerDir,input.threadId+".json");
  try {
    const ownerFd=openSync(ownerPath,"wx",0o600);
    try{writeFileSync(ownerFd,JSON.stringify({workspaceId:input.workspaceId,root:safeRoot(input.root)}));}
    finally{closeSync(ownerFd);}
  }catch(error) {
    if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    let owner:{workspaceId:string;root:string};
    try{owner=JSON.parse(readFileSync(ownerPath,"utf8"));}
    catch{throw new AppBridgeError("CODEX_APP_THREAD_OWNER_UNREADABLE");}
    if(owner.workspaceId!==input.workspaceId||owner.root!==safeRoot(input.root))
      throw new AppBridgeError("CODEX_APP_THREAD_ALREADY_OWNED");
  }
  const path=bindingPath(input.stateDir,input.workspaceId);
  mkdirSync(join(input.stateDir,"coach-app-thread-bindings"),{recursive:true,mode:0o700});
  try{
    const fd=openSync(path,"wx",0o600);
    try{writeFileSync(fd,JSON.stringify({workspaceId:input.workspaceId,root:safeRoot(input.root),threadId:input.threadId}));}
    finally{closeSync(fd);}
  }catch(error) {
    if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    if(boundSharedThread(input.stateDir,input.workspaceId)!==input.threadId)
      throw new AppBridgeError("CODEX_APP_WORKSPACE_ALREADY_BOUND");
  }
  return input.threadId;
}

export interface SendRequest {
  root:string;workspaceId:string;threadId:string;operationId:string;prompt:string;
  sandbox:"read-only"|"workspace-write";stateDir:string;socketPath?:string;timeoutMs?:number;
}
export interface TurnReceipt {state:"COMPLETED";threadId:string;operationId:string;turnId:string;reply:string;durationMs:number}
export async function sendSharedTurn(input:SendRequest):Promise<TurnReceipt>{
  if(!APP_THREAD_ID.test(input.threadId))throw new AppBridgeError("CODEX_APP_THREAD_ID_INVALID");
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.operationId) ||
     !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.workspaceId))
    throw new AppBridgeError("CODEX_APP_OPERATION_ID_INVALID");
  if(!input.prompt.trim()||input.prompt.length>MAX_PROMPT)throw new AppBridgeError("CODEX_APP_PROMPT_INVALID");
  if(input.sandbox!=="read-only"&&input.sandbox!=="workspace-write")throw new AppBridgeError("CODEX_APP_SANDBOX_INVALID");
  const timeoutMs=Math.min(Math.max(input.timeoutMs??180000,3000),3600000);
  const root=safeRoot(input.root);
  if(boundSharedThread(input.stateDir,input.workspaceId)!==input.threadId)
    throw new AppBridgeError("CODEX_APP_THREAD_NOT_BOUND");
  const key=createHash("sha256").update(input.workspaceId+"\0"+input.operationId).digest("hex");
  const fingerprint=createHash("sha256").update(JSON.stringify([root,input.threadId,input.prompt,input.sandbox])).digest("hex");
  return serial("thread:"+input.threadId,async()=>{
    const store=join(input.stateDir,"coach-app-turns");
    mkdirSync(store,{recursive:true,mode:0o700});
    const path=join(store,key+".json");
    let prior: {fingerprint:string;state:string;receipt?:TurnReceipt}|undefined;
    try{prior=JSON.parse(readFileSync(path,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new AppBridgeError("CODEX_APP_RECEIPT_UNREADABLE");}
    if(prior){
      if(prior.fingerprint!==fingerprint)throw new AppBridgeError("CODEX_APP_OPERATION_CONFLICT");
      if(prior.state==="COMPLETED"&&prior.receipt)return prior.receipt;
      // A network/client crash may have happened after turn/start; do not duplicate its message.
      throw new AppBridgeError("CODEX_APP_OPERATION_UNCERTAIN");
    }
    const fd=openSync(path,"wx",0o600);
    try{writeFileSync(fd,JSON.stringify({fingerprint,state:"PENDING",threadId:input.threadId,workspaceId:input.workspaceId}));}
    finally{closeSync(fd);}
    const save=(state:string,receipt?:TurnReceipt)=>{
      const temp=join(store,key+"."+randomBytes(6).toString("hex")+".tmp");
      writeFileSync(temp,JSON.stringify({fingerprint,state,threadId:input.threadId,workspaceId:input.workspaceId,receipt}),{mode:0o600});
      renameSync(temp,path);
    };
    const start=Date.now();
    try{
      const receipt=await withConnection(input.socketPath,async c=>{
        // The daemon can read thread metadata even when full turn history is unsupported.
        const data=await c.request("thread/read",{threadId:input.threadId,includeTurns:false},20000);
        assertThread(data?.thread,root,input.threadId);
        try {
          const resumed=await c.request("thread/resume",{threadId:input.threadId},20000);
          assertThread(resumed?.thread,root,input.threadId);
        } catch(error) {
          // Some Codex daemon builds cannot list past turns when resuming a new,
          // unloaded thread. It is safe to try turn/start after verifying cwd;
          // do not bypass any other error, particularly an active-writer lock.
          if(!(error instanceof AppBridgeError && error.code.includes("list_turns is not supported yet")))
            throw error;
        }
        let turnId:string|undefined;
        let final:SharedMessage|undefined,failed:SharedMessage|undefined,reply="";
        let settle:(value:void)=>void=()=>{};
        const completion=new Promise<void>(resolve=>{settle=resolve;});
        const off=c.observe(evt=>{
          if(evt.params?.threadId!==input.threadId)return;
          if(evt.method==="item/completed"&&evt.params?.item?.type==="agentMessage")
            reply+=String(evt.params.item.text||"");
          if(evt.method==="turn/completed"||evt.method==="turn/failed"){
            if(evt.method==="turn/completed")final=evt;else failed=evt;
            settle();
          }
        });
        let completionTimer:ReturnType<typeof setTimeout>|undefined;
        try{
          const res=await c.request("turn/start",{threadId:input.threadId,approvalPolicy:"never",
            sandboxPolicy:input.sandbox==="read-only"?{type:"readOnly"}:{type:"workspaceWrite",writableRoots:[],networkAccess:false},
            input:[{type:"text",text:input.prompt}]},20000);
          turnId=res?.turn?.id;
          if(typeof turnId!=="string")throw new AppBridgeError("CODEX_APP_TURN_NOT_ACCEPTED");
          await Promise.race([completion,new Promise<void>((_,reject)=>{completionTimer=setTimeout(()=>reject(new AppBridgeError("CODEX_APP_TURN_TIMEOUT")),timeoutMs);})]);
          if(failed||final?.params?.turn?.status!=="completed")throw new AppBridgeError("CODEX_APP_TURN_FAILED");
          const turn=final.params.turn;
          if(turn.id!==turnId)throw new AppBridgeError("CODEX_APP_TURN_MISMATCH");
          const text=reply||(Array.isArray(turn.items)?turn.items.filter((x:any)=>x.type==="agentMessage").map((x:any)=>x.text).join("\n"):"");
          if(!text)throw new AppBridgeError("CODEX_APP_EMPTY_REPLY");
          return{state:"COMPLETED" as const,threadId:input.threadId,operationId:input.operationId,
            turnId,reply:text.slice(0,MAX_REPLY),durationMs:Date.now()-start};
        }finally{if(completionTimer)clearTimeout(completionTimer);off();}
      });
      save("COMPLETED",receipt);return receipt;
    }catch(e){
      save("UNCERTAIN");throw e;
    }
  });
}
