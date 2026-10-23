#!/usr/bin/env node
/**
 * Opt-in macOS ChatGPT desktop launch using the already-running private
 * Codex App Server, not a second Codex CLI process. Does not alter plist,
 * ~/.codex/config.toml, launchctl state, login items or app binaries.
 * Roll back by quitting ChatGPT and opening it normally.
 */
import {spawnSync} from "node:child_process";
import {existsSync,lstatSync,statSync,realpathSync} from "node:fs";
import {homedir} from "node:os";
import {join,dirname,basename} from "node:path";
const socket=join(homedir(),".codex","app-server-control","app-server-control.sock");
const app="/Applications/ChatGPT.app";
const action=process.argv[2]??"--check";
const status=()=> {
  let socketOk=false;
  try{
    const s=lstatSync(socket),uid=process.getuid?.();
    if(uid!==undefined && s.uid===uid) {
      let locationOk=s.isSocket();
      if(s.isSymbolicLink()&&process.platform==="darwin"){
        const real=realpathSync(socket),folder=dirname(real),parent=statSync(folder);
        locationOk=folder==="/private/tmp/codex-daemon-"+uid &&
          /^[a-f0-9]{64}$/.test(basename(real)) && parent.isDirectory() &&
          parent.uid===uid&&(parent.mode&0o077)===0;
      }
      const target=statSync(socket);
      socketOk=locationOk&&target.isSocket()&&target.uid===uid&&(target.mode&0o077)===0;
    }
  }catch{}
  const ps=spawnSync("/bin/ps",["-axo","command="],{encoding:"utf8",timeout:5000,maxBuffer:3000000});
  const appRunning=ps.status===0&&(ps.stdout||"").split("\n").some(s=>
    /^\/Applications\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(?:\s|$)/.test(s.trim()));
  return {appFound:existsSync(app),socketOk,appRunning};
};
if(!["--check","--launch","--help"].includes(action)) {
  console.error("Usage: node scripts/launch-chatgpt-shared-codex.mjs [--check|--launch|--help]");process.exit(2);
}
if(action==="--help"){console.log("Use --check to inspect, --launch to open ChatGPT using the shared Codex App Server. No persistent changes. To undo, quit ChatGPT and open it normally.");process.exit(0);}
const before=status();
console.log(JSON.stringify({action,...before}));
if(action==="--check")process.exit(before.appFound&&before.socketOk?0:1);
if(!before.appFound||!before.socketOk){
  console.error("BLOCKED: ChatGPT app or private shared Codex socket is unavailable.");process.exit(3);
}
if(before.appRunning){console.error("BLOCKED: ChatGPT already running; never restart or seize a live chat.");process.exit(4);}
const url="ws+unix://localhost"+socket+":/rpc";
const result=spawnSync("/usr/bin/open",["-a",app,"--env","CODEX_APP_SERVER_WS_URL="+url],
 {encoding:"utf8",timeout:15000});
if(result.error||result.status!==0){
  console.error("APP_SHARED_LAUNCH_FAILED: use normal App launch to recover.");process.exit(5);
}
console.log("CHATGPT_SHARED_APP_LAUNCHED: session-only environment; no persistent setting changed.");
