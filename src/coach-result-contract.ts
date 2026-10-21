/** Agent claims are validated and frozen in native evidence, never trusted test proofs. */
import * as z from "zod/v4";
import { readConfined, reportPath, sha256, verifyTask, type TaskReference } from "./coach-task-contract.js";
const text=z.string().trim().min(1).max(8000);
const strings=z.array(text).max(200);
export const codexReportSchema=z.object({
  schema:z.literal("DEVSPACE_CODEX_REPORT_V1"),task_id:text,task_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  operation_id:text,stage_id:text,status:z.enum(["IN_PROGRESS","READY_FOR_REVIEW","PLAN_CONFLICT","BLOCKED"]),
  summary:text,changes:strings,test_results:z.array(z.object({command:text,exit_code:z.number().int(),evidence_path:text,evidence_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(100),
  remaining:strings,issues:strings,next_action:text,evidence_paths:strings,
  plan_conflict:z.object({assumption:text,counter_evidence:text,impact:text,suggested_revision:text,safe_to_continue:z.boolean()}).strict().optional(),
}).strict();
export type CodexReport=z.infer<typeof codexReportSchema>;
export interface ReportOutcome {schema:"DEVSPACE_CODEX_REPORT_CHECK_V1";valid:boolean;status?:CodexReport["status"];code:string;reportSha256?:string;testsIndependentlyVerified:false}
export function checkReport(root:string,task:TaskReference,operationId:string,stageId:string):ReportOutcome {
  const fail=(code:string):ReportOutcome=>({schema:"DEVSPACE_CODEX_REPORT_CHECK_V1",valid:false,code,testsIndependentlyVerified:false});
  try{verifyTask(root,task.workspaceId,task);}catch{return fail("REPORT_TASK_CHANGED");}
  let bytes:Buffer;try{bytes=readConfined(root,reportPath(task,operationId));}catch{return fail("REPORT_MISSING_OR_UNSAFE");}
  let raw:unknown;try{raw=JSON.parse(bytes.toString("utf8"));}catch{return fail("REPORT_JSON_INVALID");}
  const parsed=codexReportSchema.safeParse(raw);if(!parsed.success)return fail("REPORT_SCHEMA_INVALID");
  const r=parsed.data;
  if(r.task_id!==task.taskId||r.task_sha256!==task.sha256||r.operation_id!==operationId||r.stage_id!==stageId)return fail("REPORT_IDENTITY_MISMATCH");
  if(r.status==="PLAN_CONFLICT"&&!r.plan_conflict)return fail("REPORT_CONFLICT_DETAILS_REQUIRED");
  if(r.status==="READY_FOR_REVIEW"&&(r.remaining.length>0||!r.test_results.length||r.test_results.some(t=>t.exit_code!==0)))return fail("REPORT_READY_WITHOUT_TESTS");
  if(r.status==="IN_PROGRESS"&&!r.remaining.length)return fail("REPORT_REMAINING_REQUIRED");
  try{
    for(const p of r.evidence_paths)readConfined(root,p,4*1024*1024);
    for(const t of r.test_results){
      if(!r.evidence_paths.includes(t.evidence_path)||t.evidence_path===reportPath(task,operationId)||sha256(readConfined(root,t.evidence_path,4*1024*1024))!==t.evidence_sha256)return fail("REPORT_TEST_EVIDENCE_INVALID");
    }
  }catch{return fail("REPORT_EVIDENCE_MISSING_OR_UNSAFE");}
  return {schema:"DEVSPACE_CODEX_REPORT_CHECK_V1",valid:true,status:r.status,code:"REPORT_VALID_UNVERIFIED_CLAIMS",reportSha256:sha256(bytes),testsIndependentlyVerified:false};
}

/** Safe bounded event metadata: never transport agent prose, commands or raw logs. */
export function safeReportOutcome(value:unknown):ReportOutcome|undefined {
  if(!value||typeof value!=="object")return undefined;
  const r=value as ReportOutcome;
  if(r.schema!=="DEVSPACE_CODEX_REPORT_CHECK_V1"||typeof r.valid!=="boolean"||typeof r.code!=="string"||!/^REPORT_[A-Z_]{1,80}$/.test(r.code)||r.testsIndependentlyVerified!==false)return undefined;
  if(r.status!==undefined && !["IN_PROGRESS","READY_FOR_REVIEW","PLAN_CONFLICT","BLOCKED"].includes(r.status))return undefined;
  return {schema:r.schema,valid:r.valid,code:r.code,testsIndependentlyVerified:false,
    ...(r.status?{status:r.status}:{}),...(r.reportSha256 && /^[a-f0-9]{64}$/.test(r.reportSha256)?{reportSha256:r.reportSha256}:{})};
}
