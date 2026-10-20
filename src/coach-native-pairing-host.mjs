#!/usr/bin/env node
import { readFileSync, lstatSync, realpathSync, readSync } from "node:fs";
import { dirname, basename, join } from "node:path";

const EXTENSION_ID="bapcebjlgncogfpgbhllioaichcldkbl";
function readExact(length){const b=Buffer.alloc(length);let n=0;while(n<length){const got=readSync(0,b,n,length-n,null);if(!got)break;n+=got;}return n===length?b:b.subarray(0,n);}
function readMessage(){
  const head=readExact(4);
  if(head.length!==4)return null;
  const length=head.readUInt32LE(0);if(length<2||length>4096)throw new Error("invalid request");
  const body=readExact(length);if(body.length!==length)throw new Error("invalid request");
  return JSON.parse(body.toString("utf8"));
}
function reply(value){const body=Buffer.from(JSON.stringify(value));const head=Buffer.alloc(4);head.writeUInt32LE(body.length);process.stdout.write(Buffer.concat([head,body]));}
try{
  const request=readMessage(),path=process.argv[2];
  if(!request||request.type!=="get_pairing"||request.extensionId!==EXTENSION_ID||!path)throw new Error("denied");
  const st=lstatSync(path);
  if(st.isSymbolicLink()||!st.isFile()||st.size>1024||realpathSync(path)!==join(realpathSync(dirname(path)),basename(path))||(process.getuid&&st.uid!==process.getuid())||(process.platform!=="win32"&&(st.mode&0o777)!==0o600))throw new Error("denied");
  const handoff=JSON.parse(readFileSync(path,"utf8"));
  if(!Number.isInteger(handoff.port)||handoff.port<1||handoff.port>65535||! /^[A-Za-z0-9_-]{43}$/.test(handoff.token))throw new Error("denied");
  reply({ok:true,port:handoff.port,token:handoff.token});
}catch{reply({ok:false});process.exitCode=1;}
