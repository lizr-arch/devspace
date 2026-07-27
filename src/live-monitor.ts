import { statfsSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Request, Response } from "express";

const WINDOW_MS = 60_000;
const SERIES_SECONDS = 60;
const RESOURCE_HISTORY_LIMIT = 15 * 60;

interface LatencySample {
  completedAtMs: number;
  durationMs: number;
  statusCode: number;
}

interface RequestCounters {
  inFlight: number;
  peakInFlight: number;
  total: number;
  completed: number;
  errors: number;
  rejected: number;
  timeouts: number;
  starts: number[];
  latencies: LatencySample[];
}

export interface RequestMetricSnapshot {
  inFlight: number;
  peakInFlight: number;
  total: number;
  completed: number;
  errors: number;
  recentErrors: number;
  rejected: number;
  recentRejected: number;
  timeouts: number;
  recentTimeouts: number;
  errorRatePercent: number;
  perMinute: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

export interface LiveRequestSnapshot {
  http: RequestMetricSnapshot;
  mcp: RequestMetricSnapshot;
  mcpRequestsPerSecond: number[];
}

function emptyCounters(): RequestCounters {
  return {
    inFlight: 0,
    peakInFlight: 0,
    total: 0,
    completed: 0,
    errors: 0,
    rejected: 0,
    timeouts: 0,
    starts: [],
    latencies: [],
  };
}

function isMonitorPath(path: string): boolean {
  return path === "/monitor" || path.startsWith("/monitor/");
}

export class LiveRequestMonitor {
  private readonly http = emptyCounters();
  private readonly mcp = emptyCounters();

  begin(
    path: string,
    startedAtMs = Date.now(),
  ): (statusCode?: number, durationMs?: number) => void {
    if (isMonitorPath(path)) return () => undefined;
    const counters = [this.http];
    if (path === "/mcp") counters.push(this.mcp);
    for (const counter of counters) {
      counter.inFlight += 1;
      counter.peakInFlight = Math.max(counter.peakInFlight, counter.inFlight);
      counter.total += 1;
      counter.starts.push(startedAtMs);
    }

    let finished = false;
    return (statusCode = 0, durationMs = Date.now() - startedAtMs) => {
      if (finished) return;
      finished = true;
      for (const counter of counters) {
        counter.inFlight = Math.max(0, counter.inFlight - 1);
        counter.completed += 1;
        if (statusCode >= 400 || statusCode === 0) counter.errors += 1;
        if (statusCode === 429 || statusCode === 503) counter.rejected += 1;
        if (statusCode === 408 || statusCode === 504) counter.timeouts += 1;
        counter.latencies.push({
          completedAtMs: startedAtMs + Math.max(0, durationMs),
          durationMs: Math.max(0, durationMs),
          statusCode,
        });
      }
    };
  }

  snapshot(nowMs = Date.now()): LiveRequestSnapshot {
    this.prune(this.http, nowMs);
    this.prune(this.mcp, nowMs);
    const series = Array.from({ length: SERIES_SECONDS }, () => 0);
    const firstBucketMs = nowMs - (SERIES_SECONDS - 1) * 1_000;
    for (const startedAt of this.mcp.starts) {
      const index = Math.floor((startedAt - firstBucketMs) / 1_000);
      if (index >= 0 && index < SERIES_SECONDS) series[index] += 1;
    }
    return {
      http: this.toSnapshot(this.http),
      mcp: this.toSnapshot(this.mcp),
      mcpRequestsPerSecond: series,
    };
  }

  private prune(counter: RequestCounters, nowMs: number): void {
    const cutoff = nowMs - WINDOW_MS;
    const firstCurrent = counter.starts.findIndex((value) => value >= cutoff);
    if (firstCurrent === -1) {
      counter.starts.length = 0;
    } else if (firstCurrent > 0) {
      counter.starts.splice(0, firstCurrent);
    }
    const firstRecentLatency = counter.latencies.findIndex(
      (value) => value.completedAtMs >= cutoff,
    );
    if (firstRecentLatency === -1) {
      counter.latencies.length = 0;
    } else if (firstRecentLatency > 0) {
      counter.latencies.splice(0, firstRecentLatency);
    }
  }

  private toSnapshot(counter: RequestCounters): RequestMetricSnapshot {
    const durations = counter.latencies
      .map((sample) => sample.durationMs)
      .sort((left, right) => left - right);
    const latencyTotal = durations.reduce((total, value) => total + value, 0);
    const recentErrors = counter.latencies.filter(
      (sample) => sample.statusCode >= 400 || sample.statusCode === 0,
    ).length;
    const recentRejected = counter.latencies.filter(
      (sample) => sample.statusCode === 429 || sample.statusCode === 503,
    ).length;
    const recentTimeouts = counter.latencies.filter(
      (sample) => sample.statusCode === 408 || sample.statusCode === 504,
    ).length;
    return {
      inFlight: counter.inFlight,
      peakInFlight: counter.peakInFlight,
      total: counter.total,
      completed: counter.completed,
      errors: counter.errors,
      recentErrors,
      rejected: counter.rejected,
      recentRejected,
      timeouts: counter.timeouts,
      recentTimeouts,
      errorRatePercent:
        counter.latencies.length === 0
          ? 0
          : roundTo((recentErrors / counter.latencies.length) * 100, 1),
      perMinute: counter.starts.length,
      averageLatencyMs:
        durations.length === 0
          ? 0
          : Math.round(latencyTotal / durations.length),
      p50LatencyMs: percentile(durations, 50),
      p95LatencyMs: percentile(durations, 95),
      p99LatencyMs: percentile(durations, 99),
    };
  }
}

export interface ResourceHistoryPoint {
  observedAt: string;
  processCpuPercent: number;
  systemCpuPercent: number;
  rssMiB: number;
  eventLoopP95Ms: number;
}

export interface ProcessResourceSnapshot {
  processCpuPercent: number;
  processCpuAverage15s: number;
  systemCpuPercent: number;
  systemCpuAverage15s: number;
  eventLoopP95Ms: number;
  eventLoopMaxMs: number;
  rssMiB: number;
  heapUsedMiB: number;
  heapTotalMiB: number;
  externalMiB: number;
  systemMemoryUsedPercent: number;
  systemMemoryAvailableMiB: number;
  systemMemoryTotalMiB: number;
  rssGrowthMiBPerMinute: number;
  history: ResourceHistoryPoint[];
}

interface CpuTimes {
  idle: number;
  total: number;
}

export class ProcessResourceMonitor {
  private previousCpu = process.cpuUsage();
  private previousTime = process.hrtime.bigint();
  private previousSystemCpu = systemCpuTimes();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private readonly history: ResourceHistoryPoint[] = [];
  private readonly timer: NodeJS.Timeout;
  private latest?: ProcessResourceSnapshot;

  constructor(sampleIntervalMs = 1_000) {
    this.eventLoop.enable();
    this.sample();
    this.timer = setInterval(() => this.sample(), sampleIntervalMs);
    this.timer.unref();
  }

  snapshot(): ProcessResourceSnapshot {
    return (
      this.latest ?? {
        processCpuPercent: 0,
        processCpuAverage15s: 0,
        systemCpuPercent: 0,
        systemCpuAverage15s: 0,
        eventLoopP95Ms: 0,
        eventLoopMaxMs: 0,
        rssMiB: 0,
        heapUsedMiB: 0,
        heapTotalMiB: 0,
        externalMiB: 0,
        systemMemoryUsedPercent: 0,
        systemMemoryAvailableMiB: 0,
        systemMemoryTotalMiB: 0,
        rssGrowthMiBPerMinute: 0,
        history: [],
      }
    );
  }

  close(): void {
    clearInterval(this.timer);
    this.eventLoop.disable();
  }

  private sample(): void {
    const firstSample = this.history.length === 0;
    const now = process.hrtime.bigint();
    const elapsedMicroseconds = Number(now - this.previousTime) / 1_000;
    const cpu = process.cpuUsage(this.previousCpu);
    this.previousCpu = process.cpuUsage();
    this.previousTime = now;
    const processCpuPercent =
      !firstSample && elapsedMicroseconds > 0
        ? roundTo(((cpu.user + cpu.system) / elapsedMicroseconds) * 100, 1)
        : 0;

    const currentSystemCpu = systemCpuTimes();
    const totalDelta = currentSystemCpu.total - this.previousSystemCpu.total;
    const idleDelta = currentSystemCpu.idle - this.previousSystemCpu.idle;
    const systemCpuPercent =
      !firstSample && totalDelta > 0
        ? roundTo(((totalDelta - idleDelta) / totalDelta) * 100, 1)
        : 0;
    this.previousSystemCpu = currentSystemCpu;

    const memory = process.memoryUsage();
    const memoryTotal = totalmem();
    const memoryAvailable = freemem();
    const eventLoopP95Ms = nanosecondsToMilliseconds(
      this.eventLoop.percentile(95),
    );
    const eventLoopMaxMs = nanosecondsToMilliseconds(this.eventLoop.max);
    this.eventLoop.reset();

    const point: ResourceHistoryPoint = {
      observedAt: new Date().toISOString(),
      processCpuPercent,
      systemCpuPercent,
      rssMiB: bytesToMiB(memory.rss),
      eventLoopP95Ms,
    };
    this.history.push(point);
    if (this.history.length > RESOURCE_HISTORY_LIMIT) this.history.shift();
    const recentCpu = this.history.slice(-15);
    const first = this.history[0] ?? point;
    const elapsedMilliseconds =
      Date.parse(point.observedAt) - Date.parse(first.observedAt);
    const elapsedMinutes = Math.max(1, elapsedMilliseconds / 60_000);

    this.latest = {
      processCpuPercent,
      processCpuAverage15s: average(
        recentCpu.map((sample) => sample.processCpuPercent),
      ),
      systemCpuPercent,
      systemCpuAverage15s: average(
        recentCpu.map((sample) => sample.systemCpuPercent),
      ),
      eventLoopP95Ms,
      eventLoopMaxMs,
      rssMiB: point.rssMiB,
      heapUsedMiB: bytesToMiB(memory.heapUsed),
      heapTotalMiB: bytesToMiB(memory.heapTotal),
      externalMiB: bytesToMiB(memory.external),
      systemMemoryUsedPercent: roundTo(
        ((memoryTotal - memoryAvailable) / memoryTotal) * 100,
        1,
      ),
      systemMemoryAvailableMiB: bytesToMiB(memoryAvailable),
      systemMemoryTotalMiB: bytesToMiB(memoryTotal),
      rssGrowthMiBPerMinute:
        elapsedMilliseconds < 60_000
          ? 0
          : roundTo((point.rssMiB - first.rssMiB) / elapsedMinutes, 1),
      history: [...this.history],
    };
  }
}

export interface LoadAssessment {
  score: number;
  level: "idle" | "light" | "busy" | "saturated";
  label: string;
  summary: string;
  reasons: string[];
  components: {
    requests: number;
    cpu: number;
    memory: number;
    eventLoop: number;
    jobs: number;
    reliability: number;
  };
}

export function calculateLoadAssessment(input: {
  requests: LiveRequestSnapshot;
  resources: ProcessResourceSnapshot;
  jobs: { active: number; maxConcurrent: number };
}): LoadAssessment {
  const { mcp } = input.requests;
  const requests = clamp(
    Math.max(mcp.inFlight * 18, mcp.p95LatencyMs / 20),
    0,
    100,
  );
  const cpu = clamp(
    Math.max(
      input.resources.processCpuAverage15s,
      input.resources.systemCpuAverage15s,
    ),
    0,
    100,
  );
  const memory = clamp(
    Math.max(
      (input.resources.rssMiB / 1_024) * 100,
      Math.max(0, input.resources.rssGrowthMiBPerMinute) * 5,
    ),
    0,
    100,
  );
  const eventLoop = clamp(input.resources.eventLoopP95Ms / 2, 0, 100);
  const jobs =
    input.jobs.maxConcurrent > 0
      ? clamp((input.jobs.active / input.jobs.maxConcurrent) * 100, 0, 100)
      : 0;
  const reliability = clamp(
    Math.max(
      mcp.errorRatePercent * 10,
      mcp.recentRejected > 0 ? 75 : 0,
      mcp.recentTimeouts > 0 ? 75 : 0,
    ),
    0,
    100,
  );
  const components = {
    requests: Math.round(requests),
    cpu: Math.round(cpu),
    memory: Math.round(memory),
    eventLoop: Math.round(eventLoop),
    jobs: Math.round(jobs),
    reliability: Math.round(reliability),
  };
  const score = Math.round(Math.max(...Object.values(components)));
  const [level, label, summary] =
    score >= 75
      ? (["saturated", "接近饱和", "已有资源或可靠性指标接近上限"] as const)
      : score >= 50
        ? (["busy", "繁忙", "可以继续工作，但应关注主要压力项"] as const)
        : score >= 25
          ? (["light", "轻载", "存在轻微活动，当前未见饱和信号"] as const)
          : (["idle", "空闲", "当前资源余量充足"] as const);
  const reasons = Object.entries(components)
    .filter(([, value]) => value >= 25)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([name, value]) => `${componentLabel(name)} ${value}/100`);
  return {
    score,
    level,
    label,
    summary,
    reasons: reasons.length > 0 ? reasons : ["无明显压力项"],
    components,
  };
}

export function diskSpaceSnapshot(path: string): {
  availableGiB: number;
  totalGiB: number;
  usedPercent: number;
} {
  const stats = statfsSync(path);
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  return {
    availableGiB: roundTo(availableBytes / 1024 ** 3, 1),
    totalGiB: roundTo(totalBytes / 1024 ** 3, 1),
    usedPercent:
      totalBytes === 0
        ? 0
        : roundTo(((totalBytes - availableBytes) / totalBytes) * 100, 1),
  };
}

function systemCpuTimes(): CpuTimes {
  return cpus().reduce(
    (result, cpu) => ({
      idle: result.idle + cpu.times.idle,
      total:
        result.total +
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.idle +
        cpu.times.irq,
    }),
    { idle: 0, total: 0 },
  );
}

function percentile(sortedValues: number[], requested: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((requested / 100) * sortedValues.length) - 1,
  );
  return Math.round(sortedValues[index] ?? 0);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return roundTo(
    values.reduce((total, value) => total + value, 0) / values.length,
    1,
  );
}

function bytesToMiB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function nanosecondsToMilliseconds(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) return 0;
  return roundTo(nanoseconds / 1_000_000, 1);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function componentLabel(name: string): string {
  return (
    {
      requests: "请求压力",
      cpu: "CPU",
      memory: "内存",
      eventLoop: "事件循环",
      jobs: "任务槽位",
      reliability: "错误与超时",
    }[name] ?? name
  );
}

export function isLocalMonitorHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  if (value === "localhost" || value === "127.0.0.1" || value === "[::1]") {
    return true;
  }
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    return (
      closingBracket >= 0 && value.slice(0, closingBracket + 1) === "[::1]"
    );
  }
  const hostname = value.split(":", 1)[0];
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function requireLocalMonitor(req: Request, res: Response): boolean {
  const forwarded =
    req.headers["cf-connecting-ip"] ||
    req.headers["cf-ray"] ||
    req.headers["x-forwarded-for"] ||
    req.headers["x-forwarded-proto"];
  if (isLocalMonitorHost(req.headers.host) && !forwarded) return true;
  res.sendStatus(404);
  return false;
}

export function setMonitorSecurityHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

export function liveMonitorHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DevSpace Live Monitor</title>
  <style>
    :root{color-scheme:dark;--bg:#0a0c0f;--panel:#12161b;--line:#262d35;--muted:#88939f;--text:#eef2f5;--green:#65d49a;--blue:#79b8ff;--amber:#f4c56a;--red:#ff7b72}
    *{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at 15% -10%,#19242a 0,transparent 32%),var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:34px 0 48px}
    header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:26px}
    h1{font:700 clamp(24px,4vw,38px)/1.1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0 0 8px;letter-spacing:-.03em}
    .subtitle,.muted{color:var(--muted)} .status{display:flex;align-items:center;gap:9px;border:1px solid var(--line);background:#0e1216;border-radius:999px;padding:8px 12px;white-space:nowrap}
    .dot{width:9px;height:9px;border-radius:50%;background:var(--amber);box-shadow:0 0 12px currentColor}.dot.ok{background:var(--green)}.dot.busy{background:var(--blue)}.dot.bad{background:var(--red)}
    .load-hero{--load-color:var(--green);display:grid;grid-template-columns:auto 1fr;gap:24px;align-items:center;background:linear-gradient(120deg,#151b20,#101419 65%);border:1px solid var(--line);border-radius:18px;padding:22px;margin-bottom:12px}.load-hero.light{--load-color:var(--blue)}.load-hero.busy{--load-color:var(--amber)}.load-hero.saturated{--load-color:var(--red)}
    .score-ring{--score-angle:0deg;width:112px;height:112px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--load-color) var(--score-angle),#252c33 0);position:relative}.score-ring:before{content:"";position:absolute;inset:9px;border-radius:50%;background:#11161a}.score-number{position:relative;font-size:32px;font-weight:800;letter-spacing:-.06em}.score-number small{font-size:12px;color:var(--muted);letter-spacing:0}.load-copy h2{font:700 24px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0 0 6px}.load-summary{color:var(--muted)}.reason-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px}.reason{border:1px solid color-mix(in srgb,var(--load-color),transparent 55%);color:var(--load-color);border-radius:999px;padding:5px 9px;font-size:12px}.components{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:16px}.component{font-size:11px;color:var(--muted)}.meter{height:4px;background:#252c33;border-radius:3px;margin-top:5px;overflow:hidden}.meter i{display:block;height:100%;width:0;background:var(--load-color);transition:width .25s ease}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{background:linear-gradient(145deg,#14191f,#101419);border:1px solid var(--line);border-radius:14px;padding:17px;min-height:122px}
    .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.value{font-size:29px;font-weight:700;margin:10px 0 3px;letter-spacing:-.04em}.unit{font-size:14px;color:var(--muted);font-weight:400}.detail{color:var(--muted);font-size:12px}
    .wide{grid-column:span 2}.full{grid-column:1/-1}.chart{height:122px;display:flex;align-items:flex-end;gap:3px;margin-top:18px;border-bottom:1px solid var(--line);padding-bottom:1px}.bar{flex:1;min-width:2px;background:var(--blue);border-radius:2px 2px 0 0;opacity:.78;transition:height .2s ease}.bar.zero{height:2px!important;background:#27313a}.resource-chart{width:100%;height:150px;display:block;margin-top:12px}.legend{display:flex;gap:16px;color:var(--muted);font-size:11px}.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}.legend .cpu{background:var(--blue)}.legend .memory{background:var(--amber)}
    .section-title{font-size:14px;margin:25px 0 10px;color:#cbd4dc}.diagnostics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.row{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}.row span:last-child{text-align:right}
    footer{display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:12px;margin-top:18px}.warning{color:var(--amber)}
    @media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.diagnostics{grid-template-columns:1fr}.wide{grid-column:span 2}.components{grid-template-columns:repeat(3,1fr)}}
    @media(max-width:520px){main{width:min(100% - 20px,1180px);padding-top:22px}header{display:block}.status{margin-top:15px;width:max-content}.load-hero{grid-template-columns:1fr}.score-ring{width:96px;height:96px}.components{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.wide{grid-column:span 1}.value{font-size:27px}footer{display:block}}
  </style>
</head>
<body>
<main>
  <header>
    <div><h1>DevSpace Live Monitor</h1><div class="subtitle">Web GPT / MCP 本地资源与并发观察台</div></div>
    <div class="status"><i class="dot" id="dot"></i><span id="connection">正在连接…</span></div>
  </header>
  <section class="load-hero" id="load-hero">
    <div class="score-ring" id="score-ring"><div class="score-number"><span id="load-score">—</span><small>/100</small></div></div>
    <div class="load-copy">
      <h2><span id="load-label">计算中</span></h2>
      <div class="load-summary" id="load-summary">正在收集负载、延迟和资源趋势…</div>
      <div class="reason-list" id="load-reasons"></div>
      <div class="components">
        <div class="component">请求 <span id="component-requests">—</span><div class="meter"><i id="meter-requests"></i></div></div>
        <div class="component">CPU <span id="component-cpu">—</span><div class="meter"><i id="meter-cpu"></i></div></div>
        <div class="component">内存 <span id="component-memory">—</span><div class="meter"><i id="meter-memory"></i></div></div>
        <div class="component">事件循环 <span id="component-eventLoop">—</span><div class="meter"><i id="meter-eventLoop"></i></div></div>
        <div class="component">任务槽 <span id="component-jobs">—</span><div class="meter"><i id="meter-jobs"></i></div></div>
        <div class="component">可靠性 <span id="component-reliability">—</span><div class="meter"><i id="meter-reliability"></i></div></div>
      </div>
    </div>
  </section>
  <section class="grid">
    <article class="card"><div class="label">MCP 当前并发</div><div class="value"><span id="mcp-active">—</span> <span class="unit">请求</span></div><div class="detail">本次启动峰值 <span id="mcp-peak">—</span></div></article>
    <article class="card"><div class="label">最近一分钟</div><div class="value"><span id="mcp-rate">—</span> <span class="unit">MCP 请求</span></div><div class="detail">启动后累计 <span id="mcp-total">—</span></div></article>
    <article class="card"><div class="label">MCP P95 延迟</div><div class="value"><span id="p95">—</span> <span class="unit">ms</span></div><div class="detail">P50 <span id="p50">—</span> · P99 <span id="p99">—</span> ms</div></article>
    <article class="card"><div class="label">错误率 · 最近一分钟</div><div class="value"><span id="error-rate">—</span><span class="unit">%</span></div><div class="detail">拒绝 <span id="rejected">—</span> · 超时 <span id="timeouts">—</span></div></article>
    <article class="card wide"><div class="label">MCP 请求趋势 · 最近 60 秒</div><div class="chart" id="chart"></div></article>
    <article class="card"><div class="label">进程内存</div><div class="value"><span id="rss">—</span> <span class="unit">MiB RSS</span></div><div class="detail">变化 <span id="rss-growth">—</span> MiB/分钟</div></article>
    <article class="card"><div class="label">DevSpace CPU</div><div class="value"><span id="cpu">—</span><span class="unit">%</span></div><div class="detail">整机即时 <span id="system-cpu">—</span>% · 15s 均值 <span id="system-cpu-average">—</span>%</div></article>
    <article class="card"><div class="label">Event Loop Lag</div><div class="value"><span id="event-loop">—</span> <span class="unit">ms P95</span></div><div class="detail">本采样最大 <span id="event-loop-max">—</span> ms</div></article>
    <article class="card"><div class="label">系统空闲内存</div><div class="value"><span id="system-memory-free">—</span> <span class="unit">GiB</span></div><div class="detail">OS free 口径 · 已用 <span id="system-memory-used">—</span>%</div></article>
    <article class="card"><div class="label">后台任务</div><div class="value"><span id="jobs-active">—</span> <span class="unit">/ <span id="jobs-limit">—</span></span></div><div class="detail">历史任务 <span id="jobs-total">—</span></div></article>
    <article class="card"><div class="label">MCP 会话</div><div class="value"><span id="sessions-active">—</span> <span class="unit">活跃</span></div><div class="detail"><span id="transport">—</span> · 高水位 <span id="sessions-peak">—</span></div></article>
    <article class="card full"><div class="label">资源趋势 · 最近 15 分钟</div><div class="legend"><span><i class="cpu"></i>整机 CPU %</span><span><i class="memory"></i>DevSpace RSS（区间归一化）</span></div><canvas class="resource-chart" id="resource-chart"></canvas></article>
  </section>
  <h2 class="section-title">运行诊断</h2>
  <section class="diagnostics">
    <article class="card"><div class="row"><span class="muted">服务运行时间</span><span id="uptime">—</span></div><div class="row"><span class="muted">Boot ID</span><span id="boot">—</span></div><div class="row"><span class="muted">版本</span><span id="version">—</span></div></article>
    <article class="card"><div class="row"><span class="muted">HTTP 当前并发</span><span id="http-active">—</span></div><div class="row"><span class="muted">Heap</span><span><span id="heap">—</span> / <span id="heap-total">—</span> MiB</span></div><div class="row"><span class="muted">磁盘可用</span><span id="disk-free">—</span></div></article>
    <article class="card"><div class="row"><span class="muted">未知 Session</span><span id="unknown">—</span></div><div class="row"><span class="muted">任务失败 / 超时</span><span><span id="job-failed">—</span> / <span id="job-timeout">—</span></span></div><div class="row"><span class="muted">关闭错误</span><span id="close-errors">—</span></div></article>
  </section>
  <footer><span>每秒自动刷新 · 监控轮询不计入请求统计</span><span id="updated">尚未更新</span></footer>
  <footer><span class="warning">负载分数是保守的启发式信号，不代表精确的 Web GPT 数量上限；stateless 模式无法把内存归属到单个对话。</span></footer>
</main>
<script>
const byId=(id)=>document.getElementById(id);
const set=(id,value)=>{byId(id).textContent=String(value)};
const duration=(seconds)=>{const s=Math.max(0,Math.floor(seconds));const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+"天 ":"")+(h?h+"小时 ":"")+m+"分钟"};
const gib=(mib)=>(mib/1024).toFixed(1);
function renderChart(values){const chart=byId("chart");chart.replaceChildren();const max=Math.max(1,...values);for(const value of values){const bar=document.createElement("i");bar.className="bar"+(value===0?" zero":"");bar.style.height=Math.max(2,Math.round(value/max*100))+"%";bar.title=value+" 请求/秒";chart.appendChild(bar)}}
function renderLoad(load){
  const hero=byId("load-hero");hero.className="load-hero "+load.level;
  byId("score-ring").style.setProperty("--score-angle",(Math.max(0,Math.min(100,load.score))*3.6)+"deg");
  set("load-score",load.score);set("load-label",load.label);set("load-summary",load.summary);
  const reasons=byId("load-reasons");reasons.replaceChildren();
  for(const reason of load.reasons){const item=document.createElement("span");item.className="reason";item.textContent=reason;reasons.appendChild(item)}
  for(const [name,value] of Object.entries(load.components)){set("component-"+name,value);byId("meter-"+name).style.width=Math.max(0,Math.min(100,value))+"%"}
}
function renderResourceChart(history){
  const canvas=byId("resource-chart"),ratio=window.devicePixelRatio||1,width=Math.max(280,canvas.clientWidth),height=canvas.clientHeight;
  canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
  const ctx=canvas.getContext("2d");ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
  ctx.strokeStyle="#28313a";ctx.lineWidth=1;for(let row=1;row<4;row++){const y=Math.round(height*row/4)+.5;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke()}
  if(history.length<2){ctx.fillStyle="#88939f";ctx.fillText("正在积累趋势数据…",12,height/2);return}
  const rssValues=history.map(point=>point.rssMiB),rssMin=Math.min(...rssValues),rssMax=Math.max(...rssValues),rssRange=Math.max(8,rssMax-rssMin);
  const draw=(color,valueFor)=>{ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();history.forEach((point,index)=>{const x=index/(history.length-1)*width,y=height-8-Math.max(0,Math.min(1,valueFor(point)))*(height-16);if(index===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke()};
  draw("#79b8ff",point=>point.systemCpuPercent/100);draw("#f4c56a",point=>(point.rssMiB-rssMin)/rssRange);
}
function render(data){
  const r=data.requests,s=data.sessions,m=data.memory,j=data.jobs,system=data.system;
  renderLoad(data.load);
  set("mcp-active",r.mcp.inFlight);set("mcp-peak",r.mcp.peakInFlight);set("mcp-rate",r.mcp.perMinute);set("mcp-total",r.mcp.total);
  set("p50",r.mcp.p50LatencyMs);set("p95",r.mcp.p95LatencyMs);set("p99",r.mcp.p99LatencyMs);
  set("error-rate",r.mcp.errorRatePercent);set("rejected",r.mcp.rejected);set("timeouts",r.mcp.timeouts);
  set("rss",m.rssMiB);set("rss-growth",(m.rssGrowthMiBPerMinute>=0?"+":"")+m.rssGrowthMiBPerMinute);set("heap",m.heapUsedMiB);set("heap-total",m.heapTotalMiB);
  set("cpu",data.process.cpuPercent);set("system-cpu",system.cpuPercent);set("system-cpu-average",system.cpuAverage15s);
  set("event-loop",data.eventLoop.p95Ms);set("event-loop-max",data.eventLoop.maxMs);
  set("system-memory-free",gib(system.memoryAvailableMiB));set("system-memory-used",system.memoryUsedPercent);
  set("jobs-active",j.active);set("jobs-limit",j.maxConcurrent);set("jobs-total",j.total);
  set("sessions-active",s.active);set("sessions-peak",s.highWaterMark);set("transport",s.transportMode);
  set("uptime",duration(data.service.uptimeSeconds));set("boot",data.service.bootId.slice(0,8));set("version",data.service.version);
  set("http-active",r.http.inFlight);set("disk-free",system.disk.availableGiB+" / "+system.disk.totalGiB+" GiB");
  set("unknown",s.unknownSessionRequests);set("job-failed",j.byStatus.failed);set("job-timeout",j.byStatus.timed_out);set("close-errors",s.closeErrors);
  renderChart(r.mcpRequestsPerSecond);renderResourceChart(data.resourceHistory);
  byId("dot").className="dot "+(data.load.level==="saturated"?"bad":data.load.level==="busy"||r.mcp.inFlight||j.active?"busy":"ok");set("connection",data.load.label);
  set("updated","更新于 "+new Date(data.observedAt).toLocaleTimeString());
}
async function refresh(){try{const response=await fetch("/monitor/api",{cache:"no-store"});if(!response.ok)throw new Error("HTTP "+response.status);render(await response.json())}catch(error){byId("dot").className="dot bad";set("connection","连接中断");set("updated",String(error))}}
refresh();setInterval(refresh,1000);
</script>
</body>
</html>`;
}
