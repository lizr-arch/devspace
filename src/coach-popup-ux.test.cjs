"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const vm=require("node:vm");
const root=join(__dirname,"../coach-browser-extension");
const html=readFileSync(join(root,"popup.html"),"utf8");
const source=readFileSync(join(root,"autosend-popup.js"),"utf8");
const worker=readFileSync(join(root,"auto-worker.js"),"utf8");
const url="https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc";
const realRoute={workspaceId:"wsp-current",url,enabled:true,tabReady:true,grantVerified:true};
function mock(){
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 const elements=new Map(ids.map(id=>[id,{id,dataset:{},textContent:"",disabled:false,hidden:false,value:"",
   children:[],replaceChildren(){this.children=[];},append(child){this.children.push(child);},
   handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}}]));
 const emitted=[];
 let routes=[];
 const document={getElementById(id){return elements.get(id)||null;},
  createElement(tag){return{tag,textContent:"",children:[],handlers:{},append(c){this.children.push(c);},addEventListener(n,fn){this.handlers[n]=fn;}}}};
 const chrome={tabs:{async query(){return[{id:7,url}]}},
   runtime:{getManifest(){return{version:"0.3.16"};},async sendMessage(payload){emitted.push(payload);
     if(payload.type==="COACH_AUTO_STATUS")return{ok:true,state:{version:"0.3.16",routes,pendingBinding:[],recent:[],summary:{pending:0},url:routes.length?url:""}};
     return{ok:true,message:"已发送绑定请求"};}}};
 const context=vm.createContext({document,chrome,URL,console,window:{confirm:()=>true}});
 vm.runInContext(source.replace(/void autoStatus\(\);\s*$/,""),context);
 function run(state,chat=url){context.__s=state;context.__url=chat;vm.runInContext("autoConnectionUI(__s,__url)",context);}
 return {elements,emitted,run,context,updateRoutes:r=>{routes=r;},click:async()=>elements.get("auto-one-click").handlers.click()};
}
test("only one prominent connection button and legacy/manual controls are disclosed",()=>{
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(ids).size,ids.length,"all UI IDs must be unique");
 for(const id of ["auto-one-click","auto-connection-state","auto-current-chat-note","auto-feedback",
      "auto-dsh-one-click","auto-bind","auto-enable","auto-pause","auto-unbind","pair-native",
      "auto-cancel-pending","auto-status","auto-routes","auto-target","auto-diagnostic","auto-count",
      "auto-list","auto-workspace","open-panel","tasks","refresh","copy","feedback","status","extension-id"])
   assert.ok(ids.includes(id),id+" missing");
 const disclosure=html.indexOf("<details>"),main=html.indexOf('id="auto-one-click"'),legacy=html.indexOf('id="auto-dsh-one-click"');
 assert.ok(disclosure>main && legacy>disclosure,"legacy UI must not sit beside primary CTA");
 assert.match(html,/连接当前对话/);
 assert.doesNotMatch(html.slice(0,disclosure),/一键绑定并启用 DSH/);
 assert.ok(html.includes('<script src="autosend-popup.js"></script>'));
});
test("connection shows correct status for unbound, pending, claimed, paused and legacy",()=>{
 const m=mock(),get=id=>m.elements.get(id);
 m.run({routes:[],pendingBinding:[]},null);
 assert.equal(get("auto-one-click").disabled,true);
 m.run({routes:[],pendingBinding:[]});
 assert.equal(get("auto-one-click").textContent,"连接当前对话");
 assert.equal(get("auto-one-click").disabled,false);
 m.run({routes:[],pendingBinding:[{url,submitted:true}]});
 assert.equal(get("auto-one-click").disabled,true);
 assert.equal(get("auto-cancel-pending").hidden,false);
 assert.match(get("auto-current-chat-note").textContent,/已提交/);
 m.run({routes:[],pendingBinding:[{url}]});
 assert.equal(get("auto-one-click").textContent,"发送状态待核实");
 assert.match(get("auto-current-chat-note").textContent,/无法确认/);
 m.run({routes:[realRoute],pendingBinding:[]});
 assert.equal(get("auto-one-click").disabled,true);
 assert.equal(get("auto-one-click").textContent,"当前对话已连接");
 assert.equal(get("auto-connection-dot").dataset.state,"connected");
 m.run({routes:[{...realRoute,enabled:false}],pendingBinding:[]});
 assert.equal(get("auto-one-click").dataset.action,"resume");
 assert.equal(get("auto-one-click").disabled,false);
 m.run({routes:[{...realRoute,grantVerified:false}],pendingBinding:[]});
 assert.equal(get("auto-one-click").textContent,"更新当前对话连接");
 assert.equal(get("auto-one-click").dataset.action,"connect");
});
test("popup button sends approved one-click request or resumes matching route, never guesses scope",async()=>{
 const m=mock();m.updateRoutes([]);m.run({routes:[],pendingBinding:[]});
 await m.click();assert.ok(m.emitted.some(x=>x.type==="COACH_AUTO_ONE_CLICK"));
 const p=mock();p.updateRoutes([{...realRoute,enabled:false}]);p.run({routes:[{...realRoute,enabled:false}],pendingBinding:[]});
 await p.click();assert.ok(p.emitted.some(x=>x.type==="COACH_AUTO_ENABLE"&&x.workspaceId==="wsp-current"));
 assert.equal(p.emitted.some(x=>x.type==="COACH_AUTO_ONE_CLICK"),false);
});
test("worker supports one-click reauthorization of a single legacy route without silent bypass",()=>{
 assert.match(worker,/grantVerified:typeof route\?\.nonce/);
 assert.match(worker,/const currentRoutes=Object\.entries\(existing\)/);
 assert.match(worker,/currentRoutes\.length>1/);
 assert.match(worker,/COACH_AUTO_ONE_CLICK/);
 assert.match(worker,/COACH_AUTO_DSH_ONE_CLICK/);
});
