"use strict";
// Isolated-world script: neither reads the conversation nor contacts the network.
(() => {
  // V2 content scripts can survive an extension reload in an open ChatGPT tab.
  // V3 must coexist safely: only this version handles V3 messages.
  if (globalThis.__devspaceCoachDeliveryV3Installed) return;
  globalThis.__devspaceCoachDeliveryV3Installed = true;
  const canonical=url=>{
    try {
      const u=new URL(url);
      return u.protocol==="https:" && u.hostname==="chatgpt.com" &&
        /^\/(?:g\/[^/]+\/)?c\/[A-Za-z0-9_-]{8,128}\/?$/.test(u.pathname) ?
        u.origin+u.pathname.replace(/\/$/,""):null;
    }catch{return null;}
  };
  const visible=el=>!!el && el.isConnected && !el.hidden &&
    getComputedStyle(el).display!=="none" && getComputedStyle(el).visibility!=="hidden";
  const single=selector=>{
    const nodes=[...document.querySelectorAll(selector)].filter(visible);
    return nodes.length===1?nodes[0]:null;
  };
  // ChatGPT may render a labelled ProseMirror editor instead of #prompt-textarea.
  // Explicitly allow only known composer identities, never a generic contenteditable.
  // Resolve *all* candidates first: competing editors are an ambiguity, not a fallback.
  const findEditor=()=>{
    const selectors=[
      '#prompt-textarea[contenteditable="true"]',
      '[data-testid="prompt-textarea"][contenteditable="true"]',
      '[aria-label="Ask ChatGPT"][contenteditable="true"]',
      '[aria-label="向 ChatGPT 提问"][contenteditable="true"]',
      'contenteditable[aria-label="Ask ChatGPT"]',
      'contenteditable[aria-label="向 ChatGPT 提问"]'
    ];
    const candidates=[...new Set(selectors.flatMap(s=>[...document.querySelectorAll(s)]))]
      .filter(visible)
      .filter(el=>el.isContentEditable===true || el.getAttribute("contenteditable")==="true");
    return candidates.length===1?candidates[0]:null;
  };
  const findSend=()=>single(
    'button[data-testid="send-button"],button[aria-label="Send prompt"],'+
    'button[aria-label="Send message"],button[aria-label="发送消息"],'+
    'button[aria-label="Send"],button[aria-label="发送"]'
  );
  let sending=false;
  async function deliver(msg) {
    if(sending)return {ok:false,notSubmitted:true,reason:"投递正在进行"};
    if(window.top!==window || canonical(location.href)!==msg.url ||
      canonical(msg.url)===null || typeof msg.instruction!=="string" ||
      msg.instruction.length>1500 || !msg.instruction.startsWith("请以 Web GPT Coach 身份独立审核"))
      return {ok:false,notSubmitted:true,reason:"目标对话不匹配"};
    const editor=findEditor();
    if(!editor)return {ok:false,notSubmitted:true,reason:"找不到唯一的 ChatGPT 编辑器（旧版或带标签的新版输入框）"};
    if((editor.innerText||editor.textContent||"").trim())
      return {ok:false,notSubmitted:true,reason:"用户已有草稿，未覆盖"};
    if(document.querySelector('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"],button[aria-label="停止生成"]'))
      return {ok:false,notSubmitted:true,reason:"Web GPT 正在生成"};
    if(!editor.isConnected)return {ok:false,notSubmitted:true,reason:"编辑器已变化"};
    sending=true;
    try {
      if((editor.innerText||editor.textContent||"").trim())
        return {ok:false,notSubmitted:true,reason:"编辑期间出现用户草稿"};
      editor.focus();
      const selection=window.getSelection();
      const range=document.createRange();
      range.selectNodeContents(editor);range.collapse(false);
      selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand("insertText",false,msg.instruction))
        return {ok:false,reason:"不能安全输入审核指令"};
      if((editor.innerText||editor.textContent||"").trim()!==msg.instruction)
        return {ok:false,reason:"输入内容没有得到确认"};
      const send=findSend();
      if(!send||send.disabled||send.getAttribute("aria-disabled")==="true")
        return {ok:false,reason:"发送按钮不可用，保留草稿等待人工处理"};
      if(canonical(location.href)!==msg.url)return {ok:false,reason:"页面已导航"};
      if(document.querySelector('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"],button[aria-label="停止生成"]'))
        return {ok:false,reason:"生成状态变化，已保留草稿"};
      send.click();
      // Only inspect composer; DO NOT read or scrape any conversation messages.
      for(let i=0;i<12;i++){
        await new Promise(r=>setTimeout(r,250));
        if(canonical(location.href)!==msg.url)return {ok:false,reason:"发送时页面变化"};
        if((editor.innerText||editor.textContent||"").trim()==="")
          return {ok:true,submitted:true};
      }
      return {ok:false,uncertain:true,reason:"发送后编辑器未确认清空，请人工核查"};
    }catch{return {ok:false,uncertain:true,reason:"浏览器输入或发送异常"};}
    finally{sending=false;}
  }
  chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
    if(msg?.type==="COACH_AUTO_PING_V3") {
      reply({ok:true,protocol:3,url:canonical(location.href)});
      return false;
    }
    if(msg?.type!=="COACH_AUTO_DELIVER_V3")return false;
    void deliver(msg).then(reply).catch(()=>reply({ok:false,uncertain:true,reason:"投递异常"}));
    return true;
  });
})();
