/**
 * ONEPASS-003-NATIVE-TX-004 M1 / G6+G10: read-only native rollout observation.
 * Parses the persisted JSONL (including both event_msg item_completed and
 * response_item message projections of the same logical user message), tracks a
 * pre-send baseline, and correlates the new user item with its turn lifecycle
 * and assistant reply. Multiple projections of the same turn count once.
 */
import {
 type NativeOutboundRuntime,
 sha256Hex,
} from "./coach-native-outbound-types.js";

/* ------------------------------------------------------------------ *
 * Rollout observation (read-only; multiple projections count once)
 * ------------------------------------------------------------------ */

interface UserDelivery {turnId?:string;itemId?:string;source:"event"|"response";text:string;index:number}
interface ReplyDelivery {turnId?:string;text:string;index:number;source:"event"|"response"}
interface ObservedRollout {
 available:boolean;
 path?:string;
 deliveries:UserDelivery[];
 replies:ReplyDelivery[];
 started:Set<string>;
 completed:Set<string>;
 lineCount:number;
 size:number;
}

interface BaselineObservation {
 path?:string;
 size:number;
 deliveryTurnIds:Set<string>;
 deliveryItemIds:Set<string>;
 started:Set<string>;
 completed:Set<string>;
}

export function emptyObservation():ObservedRollout{
 return {available:false,deliveries:[],replies:[],started:new Set(),completed:new Set(),lineCount:0,size:0};
}

function joinedItemText(content:unknown):string{
 if(!Array.isArray(content))return "";
 return content
  .filter(part=>part&&typeof part==="object"&&typeof (part as {text?:unknown}).text==="string")
  .map(part=>String((part as {text:string}).text))
  .join("");
}

function parseRolloutObservation(raw:string,threadId:string,payloadSha256:string):ObservedRollout{
 const endsWithNewline=raw.endsWith("\n");
 const lines=raw.split("\n");
 if(endsWithNewline)lines.pop();
 const deliveries:UserDelivery[]=[];
 const replies:ReplyDelivery[]=[];
 const started=new Set<string>();
 const completed=new Set<string>();
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  if(!line.trim())continue;
  let record:any;
  try{record=JSON.parse(line);}catch{
   if(!endsWithNewline&&index===lines.length-1)continue;
   return {...emptyObservation(),lineCount:lines.length,size:raw.length};
  }
  const payload=record?.payload;
  if(!payload||typeof payload!=="object")continue;
  if(record.type==="event_msg"){
   if(payload.type==="task_started"&&typeof payload.turn_id==="string"){started.add(payload.turn_id);continue;}
   if(payload.type==="task_complete"&&typeof payload.turn_id==="string"){completed.add(payload.turn_id);continue;}
   if(payload.type==="item_completed"){
    const item=payload.item;
    if(!item||typeof item!=="object"||typeof item.type!=="string")continue;
    const text=joinedItemText(item.content);
    const turnId=typeof payload.turn_id==="string"?payload.turn_id:undefined;
    const itemId=typeof item.id==="string"?item.id:undefined;
    if(item.type==="UserMessage"&&sha256Hex(text)===payloadSha256)
     deliveries.push({...(turnId?{turnId}:{}),...(itemId?{itemId}:{}),source:"event",text,index});
    else if(item.type==="AgentMessage"&&text)
     replies.push({...(turnId?{turnId}:{}),text,index,source:"event"});
   }
  }else if(record.type==="response_item"&&payload.type==="message"&&payload.role==="user"){
   const text=joinedItemText(payload.content);
   if(!text||sha256Hex(text)!==payloadSha256)continue;
   const turnId=typeof payload?.internal_chat_message_metadata_passthrough?.turn_id==="string"
    ?payload.internal_chat_message_metadata_passthrough.turn_id
    :undefined;
   const itemId=typeof payload.id==="string"?payload.id:undefined;
   deliveries.push({...(turnId?{turnId}:{}),...(itemId?{itemId}:{}),source:"response",text,index});
  }else if(record.type==="response_item"&&payload.type==="message"&&payload.role==="assistant"){
   const text=joinedItemText(payload.content);
   if(!text)continue;
   const turnId=typeof payload?.internal_chat_message_metadata_passthrough?.turn_id==="string"
    ?payload.internal_chat_message_metadata_passthrough.turn_id
    :undefined;
   replies.push({...(turnId?{turnId}:{}),text,index,source:"response"});
  }
 }
 return {available:true,deliveries,replies,started,completed,lineCount:lines.length,size:raw.length};
}

export function baselineOf(observation:ObservedRollout):BaselineObservation{
 const deliveryTurnIds=new Set<string>(),deliveryItemIds=new Set<string>();
 for(const delivery of observation.deliveries){
  if(delivery.turnId)deliveryTurnIds.add(delivery.turnId);
  if(delivery.itemId)deliveryItemIds.add(delivery.itemId);
 }
 return {
  ...(observation.path?{path:observation.path}:{}),
  size:observation.size,
  deliveryTurnIds,deliveryItemIds,
  started:new Set(observation.started),completed:new Set(observation.completed),
 };
}

export function observeRollout(runtime:NativeOutboundRuntime,input:{threadId:string;codexHome:string;payloadSha256:string;cached?:{size:number;observation:ObservedRollout}}):ObservedRollout{
 let path:string;
 try{path=runtime.findRollout(input.threadId,input.codexHome);}catch{
  return emptyObservation();
 }
 let size=0;
 try{size=runtime.statFile(path).size;}catch{return emptyObservation();}
 if(input.cached&&input.cached.size===size)return input.cached.observation;
 let raw:string;
 try{raw=runtime.readRolloutText(path);}catch{return emptyObservation();}
 const observation=parseRolloutObservation(raw,input.threadId,input.payloadSha256);
 return {...observation,available:true,path};
}

/** Queue stdout contract: exactly `Queued message <uuid> for thread <uuid>.` */
const QUEUED_MESSAGE=/^Queued message ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) for thread ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.\s*$/m;

export function parseQueuedMessage(stdout:string):{messageId:string;threadId:string}|undefined{
 const match=QUEUED_MESSAGE.exec(stdout);
 return match?{messageId:match[1],threadId:match[2]}:undefined;
}

export interface DeliveryAnalysis {
 logicalDeliveries:number;
 turnId?:string;
 userItemId?:string;
 firstNewIndex:number;
}

/** Baseline-relative, projection-deduped delivery analysis for one payload sha. */
export function analyzeDeliveries(observation:ObservedRollout,baseline:BaselineObservation):DeliveryAnalysis{
 const newTurnIds=new Set<string>();
 let orphanNew=0;
 let eventItemId:string|undefined;
 let responseItemId:string|undefined;
 let firstNewIndex=Number.MAX_SAFE_INTEGER;
 for(const delivery of observation.deliveries){
  const isNew=delivery.turnId
   ?!baseline.deliveryTurnIds.has(delivery.turnId)
   :!(delivery.itemId&&baseline.deliveryItemIds.has(delivery.itemId));
  if(!isNew)continue;
  if(delivery.turnId)newTurnIds.add(delivery.turnId);else orphanNew+=1;
  firstNewIndex=Math.min(firstNewIndex,delivery.index);
  if(delivery.source==="event"&&delivery.itemId)eventItemId=delivery.itemId;
  if(delivery.source==="response"&&delivery.itemId)responseItemId=delivery.itemId;
 }
 const turnId=[...newTurnIds][0];
 return {
  logicalDeliveries:newTurnIds.size+(newTurnIds.size?0:orphanNew),
  ...(turnId?{turnId}:{}),
  ...(eventItemId??responseItemId?{userItemId:eventItemId??responseItemId}:{}),
  firstNewIndex,
 };
}

/** Reply correlated to the observed turn (or, without turn ids, after the user item). */
export function selectReply(observation:ObservedRollout,analysis:DeliveryAnalysis):string|undefined{
 const candidates=[...observation.replies].reverse();
 const reply=analysis.turnId
  ?candidates.find(candidate=>candidate.turnId===analysis.turnId&&candidate.text.trim())
  :candidates.find(candidate=>candidate.index>analysis.firstNewIndex&&candidate.text.trim());
 return reply?.text.trim()?reply.text:undefined;
}

export type {ObservedRollout,BaselineObservation};
