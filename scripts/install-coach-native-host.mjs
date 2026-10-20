#!/usr/bin/env node
// One-time, user-invoked Chrome Native Messaging registration. All installed
// paths are stable across DevSpace git worktree cleanups and branch changes.
import {mkdirSync,writeFileSync,chmodSync,realpathSync,readFileSync,lstatSync,renameSync,unlinkSync} from "node:fs";
import {homedir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";

const EXTENSION_ID="bapcebjlgncogfpgbhllioaichcldkbl";
const HOST_NAME="com.devspace.coach_pairing";
export function resolveStateDir(explicitStateDir,home=homedir()) {
  return resolve(explicitStateDir||join(home,".local","share","devspace"));
}
function shQuote(s){return "'"+s.replaceAll("'","'\\''")+"'";}
function ownerOnlyDirectory(path,{strict=false}={}){
  const stat=lstatSync(path);
  if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(path)!==path||
     (process.getuid&&stat.uid!==process.getuid())||
     (strict?(stat.mode&0o077)!==0:(stat.mode&0o022)!==0))
    throw new Error("COACH_NATIVE_HOST_DIRECTORY_UNSAFE");
}
function prepareDirectory(path,mode,strict=false){
  mkdirSync(path,{recursive:true,mode});
  ownerOnlyDirectory(path,{strict});
}
function checkedTarget(path){
  try{
    const st=lstatSync(path);
    if(st.isSymbolicLink()||!st.isFile()||realpathSync(path)!==path||
       (process.getuid&&st.uid!==process.getuid()))
      throw new Error("COACH_NATIVE_HOST_TARGET_UNSAFE");
  }catch(error){
    if(error?.code!=="ENOENT")throw error;
  }
}
function atomicOwnerWrite(path,data,mode){
  checkedTarget(path);
  const tmp=path+"."+randomUUID()+".tmp";
  try{
    writeFileSync(tmp,data,{flag:"wx",mode});
    chmodSync(tmp,mode);
    // The same-user race cannot elevate permissions: only a checked file
    // inside the owner-controlled directory is replaced.
    checkedTarget(path);
    renameSync(tmp,path);
  }catch(error){try{unlinkSync(tmp);}catch{}throw error;}
}
export function installNativeHost({home=homedir(),stateDir=resolveStateDir(undefined,home),
                                  nodePath=process.execPath,hostSource}={}){
  if(process.platform!=="darwin")throw new Error("COACH_NATIVE_HOST_MACOS_ONLY");
  const state=resolveStateDir(stateDir,home);
  ownerOnlyDirectory(state,{strict:true});
  const source=realpathSync(hostSource||fileURLToPath(new URL("../src/coach-native-pairing-host.mjs",import.meta.url)));
  const sourceStat=lstatSync(source);
  if(sourceStat.isSymbolicLink()||!sourceStat.isFile())throw new Error("COACH_NATIVE_HOST_SOURCE_UNSAFE");
  const installedDir=join(home,"Library","Application Support","DevSpace","CoachNativeHost");
  prepareDirectory(installedDir,0o700,true);
  const chromeHosts=join(home,"Library","Application Support","Google","Chrome","NativeMessagingHosts");
  prepareDirectory(chromeHosts,0o700);
  const installedHost=join(installedDir,"host.mjs");
  atomicOwnerWrite(installedHost,readFileSync(source),0o600);
  const launcher=join(chromeHosts,HOST_NAME);
  atomicOwnerWrite(launcher,"#!/bin/sh\nexec "+shQuote(resolve(nodePath))+" "+shQuote(installedHost)+" "+shQuote(join(state,"coach-current-pairing.json"))+"\n",0o700);
  const manifest={name:HOST_NAME,description:"DevSpace Coach pairing handoff",
    path:launcher,type:"stdio",allowed_origins:["chrome-extension://"+EXTENSION_ID+"/"]};
  atomicOwnerWrite(join(chromeHosts,HOST_NAME+".json"),JSON.stringify(manifest,null,2)+"\n",0o600);
  return {launcher,manifestPath:join(chromeHosts,HOST_NAME+".json"),installedHost};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  installNativeHost({stateDir:resolveStateDir(process.argv[2])});
  console.log("DevSpace Coach Native Messaging host registered in a stable user-owned directory. Restart Chrome once.");
}
