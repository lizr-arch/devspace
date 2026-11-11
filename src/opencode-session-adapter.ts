import {realpath} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync=promisify(execFile);

export interface OpenCodeSessionIdentity {
  id:string;
  location:{directory:string};
  agent?:string;
  model?:{providerID:string;id:string;variant?:string};
}

export interface OpenCodeApiResponse<T> {
  status:number;
  body:T;
}

export interface OpenCodeSessionAdapterOptions {
  baseUrl:string;
  directory:string;
  sessionId:string;
  /** Injected for tests; production uses the official `opencode api` client. */
  request?:(method:"GET"|"POST",path:string,directory:string,data?:unknown)=>Promise<OpenCodeApiResponse<unknown>>;
}

export class OpenCodeSessionAdapter {
  private readonly directory:string;
  private readonly requestImpl:NonNullable<OpenCodeSessionAdapterOptions["request"]>;

  private constructor(private readonly options:OpenCodeSessionAdapterOptions,directory:string){
    this.directory=directory;
    this.requestImpl=options.request??officialApiRequest(options.baseUrl);
  }

  static async authorize(options:OpenCodeSessionAdapterOptions):Promise<OpenCodeSessionAdapter>{
    if(!/^ses_[A-Za-z0-9]+$/.test(options.sessionId))throw new Error("OPENCODE_SESSION_ID_INVALID");
    if(!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(options.baseUrl))throw new Error("OPENCODE_BASE_URL_MUST_BE_LOOPBACK");
    return new OpenCodeSessionAdapter(options,await realpath(options.directory));
  }

  async readSession():Promise<OpenCodeSessionIdentity>{
    const response=await this.requestImpl("GET",`/api/session/${encodeURIComponent(this.options.sessionId)}`,this.directory);
    if(response.status!==200)throw new Error(`OPENCODE_SESSION_READ_HTTP_${response.status}`);
    const session=unwrapData<OpenCodeSessionIdentity>(response.body);
    if(session.id!==this.options.sessionId)throw new Error("OPENCODE_SESSION_ID_MISMATCH");
    const actual=await realpath(session.location.directory).catch(()=>session.location.directory);
    if(actual!==this.directory)throw new Error("OPENCODE_SESSION_DIRECTORY_MISMATCH");
    return session;
  }

  async prompt(text:string):Promise<unknown>{
    if(!text.trim())throw new Error("OPENCODE_PROMPT_EMPTY");
    await this.readSession();
    const response=await this.requestImpl("POST",`/api/session/${encodeURIComponent(this.options.sessionId)}/prompt`,this.directory,{text});
    if(response.status!==200)throw new Error(`OPENCODE_PROMPT_HTTP_${response.status}`);
    return unwrapData(response.body);
  }

  async messages():Promise<unknown[]>{
    await this.readSession();
    const response=await this.requestImpl("GET",`/api/session/${encodeURIComponent(this.options.sessionId)}/message`,this.directory);
    if(response.status!==200)throw new Error(`OPENCODE_MESSAGES_HTTP_${response.status}`);
    const data=unwrapData<unknown[]>(response.body);
    if(!Array.isArray(data))throw new Error("OPENCODE_MESSAGES_INVALID");
    return data;
  }

  async waitForTurn(userMessageId:string,timeoutMs=180_000):Promise<Record<string,unknown>>{
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const messages=await this.messages() as Array<Record<string,unknown>>;
      const user=messages.find(message=>message.id===userMessageId&&message.type==="user");
      if(!user)throw new Error("OPENCODE_ACCEPTED_USER_MESSAGE_NOT_FOUND");
      const created=((user.time as {created?:number}|undefined)?.created??0);
      const assistants=messages.filter(message=>message.type==="assistant"&&
        (((message.time as {created?:number}|undefined)?.created??0)>=created));
      const completed=assistants.find(message=>
        typeof (message.time as {completed?:number}|undefined)?.completed==="number"&&
        message.finish==="stop");
      if(completed){
        if(completed.error)throw new Error("OPENCODE_ASSISTANT_TURN_FAILED");
        return completed;
      }
      const failed=assistants.find(message=>message.error||message.finish==="error");
      if(failed)throw new Error("OPENCODE_ASSISTANT_TURN_FAILED");
      await new Promise(resolve=>setTimeout(resolve,750));
    }
    throw new Error("OPENCODE_TURN_OUTCOME_UNCERTAIN_TIMEOUT");
  }
}

function unwrapData<T>(body:unknown):T{
  if(body&&typeof body==="object"&&"data" in body)return (body as {data:T}).data;
  return body as T;
}

function officialApiRequest(baseUrl:string):NonNullable<OpenCodeSessionAdapterOptions["request"]>{
  return async(method,path,directory,data)=>{
    const service=await execFileAsync("opencode",["service","status"],{encoding:"utf8",timeout:10_000});
    if(service.stdout.trim()!==baseUrl)throw new Error("OPENCODE_SERVICE_ADDRESS_MISMATCH");
    // Use the official CLI's configured background-service connection so its
    // local authentication is preserved; --server would require re-supplying
    // OPENCODE_PASSWORD and risks widening credential handling in DevSpace.
    const args=["api",method,path,"--header",`x-opencode-directory: ${directory}`];
    if(data!==undefined)args.push("--data",JSON.stringify(data));
    let stdout="";
    try{
      const result=await execFileAsync("opencode",args,{encoding:"utf8",timeout:120_000,maxBuffer:8*1024*1024});
      stdout=result.stdout;
    }catch(error){
      const e=error as Error&{stdout?:string;stderr?:string;code?:number|string};
      const responseText=e.stdout?.trim()||e.stderr?.trim()||e.message;
      throw new Error(`OPENCODE_API_CLI_FAILED:${String(e.code??"unknown")}:${responseText}`);
    }
    let body:unknown;
    try{body=JSON.parse(stdout);}catch{throw new Error("OPENCODE_API_RESPONSE_NOT_JSON");}
    return{status:200,body};
  };
}
