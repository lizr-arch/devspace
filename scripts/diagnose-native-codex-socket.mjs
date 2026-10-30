import {homedir} from 'node:os';
import {connect} from 'node:net';
import {randomBytes} from 'node:crypto';
import {lstatSync,statSync,readdirSync,realpathSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
const uid=process.getuid?.();
const root=join(homedir(),'.codex');
const directory=join(root,'app-server-control');
const socket=join(directory,'app-server-control.sock');
const privateDir=typeof uid==='number'?'/private/tmp/codex-daemon-'+uid:undefined;
const info=path=>{
  try {
    const s=lstatSync(path);
    return {exists:true,type:s.isSymbolicLink()?'symlink':s.isSocket()?'socket':s.isDirectory()?'directory':s.isFile()?'regular-file':'other',ownedByProcessUid:s.uid===uid,privateMode:(s.mode&0o077)===0};
  } catch(e){return {exists:false,reason:e?.code??'UNKNOWN'};}
};
const out={diagnostic:'native_codex_app_socket_metadata',platform:process.platform,uidAvailable:uid!==undefined,homeDirMatchesProcess:true,paths:{
  homeCodex:info(root),sharedParent:info(directory),sharedSocket:info(socket),
  daemonDir:privateDir?info(privateDir):{exists:false,reason:'UID_UNAVAILABLE'}
}};
try {
  if(out.paths.sharedSocket.exists && out.paths.sharedSocket.type==='symlink'){
    let target;try{target=realpathSync(socket)}catch(e){out.paths.symlinkTarget={resolvable:false,reason:e?.code??'UNKNOWN'};}
    if(target){
      const infoTarget=info(target);
      out.paths.symlinkTarget={resolvable:true,expectedPrivateDaemon:dirname(target)===privateDir,expectedOpaqueName:/^[0-9a-f]{64}$/.test(basename(target)),...infoTarget};
    }
  }else if(out.paths.sharedSocket.exists && out.paths.sharedSocket.type==='socket'){
    const s=statSync(socket);out.paths.liveSocket={ownedByProcessUid:s.uid===uid,privateMode:(s.mode&0o077)===0};
  }
}catch(e){out.paths.socketInspectionError=e?.code??'UNKNOWN'}
for(const [name,path] of [['sharedParent',directory],['daemonDir',privateDir]]){
  if(!path)continue;
  try{const dirs=readdirSync(path,{withFileTypes:true});out.paths[name+'Entries']={count:dirs.length,socketLike:dirs.filter(x=>x.name.endsWith('.sock')).length};}
  catch(e){out.paths[name+'Entries']={error:e?.code??'UNKNOWN'}}
}
const describeEntry=(base,name)=>{
  const value=info(join(base,name));
  return {namePattern:/^[0-9a-f]{64}$/.test(name)?'opaque64':name==='app-server-control.sock'?'expected-socket':name.startsWith('.')?'hidden':'other',nameLength:name.length,...value};
};
for(const [label,base] of [['sharedParent',directory],['daemonDir',privateDir]]){
  if(!base)continue;
  try{out.paths[label+'EntryKinds']=readdirSync(base).slice(0,20).map(n=>describeEntry(base,n));}
  catch(e){out.paths[label+'EntryKinds']={error:e?.code??'UNKNOWN'}}
}
// Verify the *existing* single private daemon socket using read-only App protocol.
// This does not start/restart the App, acquire a writer, or create a symlink.
try {
  const all=privateDir?readdirSync(privateDir):[];
  const eligible=all.filter(n=>/^[0-9a-f]{64}$/.test(n)).map(n=>join(privateDir,n)).filter(p=>{
    const s=info(p);return s.exists && s.type==='socket' && s.ownedByProcessUid && s.privateMode;
  });
  out.readOnlyProtocol={eligibleSockets:eligible.length};
  if(eligible.length===1){
    const socketPath=eligible[0];
    try {
      const nativeBridge=await import('../src/coach-app-server-bridge.ts');
      out.readOnlyProtocol.actualBridgeStatus=await nativeBridge.sharedAppStatus(socketPath);
    }catch(e){out.readOnlyProtocol.actualBridgeStatus={connected:false,error:e?.code??e?.message??'IMPORT_FAILED'};}
    const probePath=path=>new Promise(resolve=>{
      const socket=connect(socketPath);let settled=false,header='';
      const finish=data=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve(data);};
      const timer=setTimeout(()=>finish({connected:false,error:'WEBSOCKET_HANDSHAKE_TIMEOUT'}),3500);
      socket.once('connect',()=>{
        const key=randomBytes(16).toString('base64');
        socket.write(['GET '+path+' HTTP/1.1','Host: localhost','Connection: Upgrade','Upgrade: websocket','Sec-WebSocket-Key: '+key,'Sec-WebSocket-Version: 13','',''].join(String.fromCharCode(13,10)));
      });
      socket.on('data',chunk=>{
        header+=chunk.toString('latin1');
        if(header.includes(String.fromCharCode(13,10,13,10)))finish({connected:header.startsWith('HTTP/1.1 101 '),statusCode:header.split(' ')[1]??'INVALID'});
        if(header.length>4096)finish({connected:false,error:'RESPONSE_TOO_LARGE'});
      });
      socket.on('error',error=>finish({connected:false,error:error.code??'SOCKET_ERROR'}));
      socket.on('close',()=>finish({connected:false,error:'CLOSED_BEFORE_HANDSHAKE'}));
    });
    out.readOnlyProtocol.rpcEndpointProbe=await probePath('/rpc');
    out.readOnlyProtocol.status=await new Promise(resolve=>{
      const socket=connect(socketPath);
      let settled=false,header='';
      const finish=data=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve(data);};
      const timer=setTimeout(()=>finish({connected:false,error:'WEBSOCKET_HANDSHAKE_TIMEOUT'}),5000);
      socket.once('connect',()=>{
        const key=randomBytes(16).toString('base64');
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      socket.on('data',chunk=>{
        header+=chunk.toString('latin1');
        if(header.includes('\r\n\r\n'))finish({connected:/^HTTP\/1\.1 101\b/.test(header)&&/upgrade: websocket/i.test(header),handshake:'HTTP_WS',error:/^HTTP\/1\.1 101\b/.test(header)?undefined:'REJECTED'});
        if(header.length>4096)finish({connected:false,error:'RESPONSE_TOO_LARGE'});
      });
      socket.on('error',error=>finish({connected:false,error:error.code??'SOCKET_ERROR'}));
      socket.on('close',()=>finish({connected:false,error:'CLOSED_BEFORE_HANDSHAKE'}));
    });
  }
}catch(e){out.readOnlyProtocol={error:e?.code??e?.message??'UNKNOWN'};}
console.log(JSON.stringify(out,null,2));
