import type { Request, Response } from "express";

const WINDOW_MS = 60_000;
const SERIES_SECONDS = 60;
const RECENT_LATENCY_LIMIT = 512;

interface RequestCounters {
  inFlight: number;
  peakInFlight: number;
  total: number;
  completed: number;
  errors: number;
  starts: number[];
  latencies: number[];
}

export interface RequestMetricSnapshot {
  inFlight: number;
  peakInFlight: number;
  total: number;
  completed: number;
  errors: number;
  perMinute: number;
  averageLatencyMs: number;
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
        counter.latencies.push(Math.max(0, durationMs));
        if (counter.latencies.length > RECENT_LATENCY_LIMIT) {
          counter.latencies.splice(
            0,
            counter.latencies.length - RECENT_LATENCY_LIMIT,
          );
        }
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
  }

  private toSnapshot(counter: RequestCounters): RequestMetricSnapshot {
    const latencyTotal = counter.latencies.reduce(
      (total, value) => total + value,
      0,
    );
    return {
      inFlight: counter.inFlight,
      peakInFlight: counter.peakInFlight,
      total: counter.total,
      completed: counter.completed,
      errors: counter.errors,
      perMinute: counter.starts.length,
      averageLatencyMs:
        counter.latencies.length === 0
          ? 0
          : Math.round(latencyTotal / counter.latencies.length),
    };
  }
}

export class ProcessCpuSampler {
  private previousCpu = process.cpuUsage();
  private previousTime = process.hrtime.bigint();
  private lastPercent = 0;

  snapshot(): number {
    const now = process.hrtime.bigint();
    const elapsedMicroseconds = Number(now - this.previousTime) / 1_000;
    const cpu = process.cpuUsage(this.previousCpu);
    this.previousCpu = process.cpuUsage();
    this.previousTime = now;
    if (elapsedMicroseconds > 0) {
      this.lastPercent = ((cpu.user + cpu.system) / elapsedMicroseconds) * 100;
    }
    return Math.round(this.lastPercent * 10) / 10;
  }
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
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{background:linear-gradient(145deg,#14191f,#101419);border:1px solid var(--line);border-radius:14px;padding:17px;min-height:122px}
    .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.value{font-size:29px;font-weight:700;margin:10px 0 3px;letter-spacing:-.04em}.unit{font-size:14px;color:var(--muted);font-weight:400}.detail{color:var(--muted);font-size:12px}
    .wide{grid-column:span 2}.chart{height:122px;display:flex;align-items:flex-end;gap:3px;margin-top:18px;border-bottom:1px solid var(--line);padding-bottom:1px}.bar{flex:1;min-width:2px;background:var(--blue);border-radius:2px 2px 0 0;opacity:.78;transition:height .2s ease}.bar.zero{height:2px!important;background:#27313a}
    .section-title{font-size:14px;margin:25px 0 10px;color:#cbd4dc}.diagnostics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.row{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}.row span:last-child{text-align:right}
    footer{display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:12px;margin-top:18px}.warning{color:var(--amber)}
    @media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.diagnostics{grid-template-columns:1fr}.wide{grid-column:span 2}}
    @media(max-width:520px){main{width:min(100% - 20px,1180px);padding-top:22px}header{display:block}.status{margin-top:15px;width:max-content}.grid{grid-template-columns:1fr}.wide{grid-column:span 1}.value{font-size:27px}footer{display:block}}
  </style>
</head>
<body>
<main>
  <header>
    <div><h1>DevSpace Live Monitor</h1><div class="subtitle">Web GPT / MCP 本地资源与并发观察台</div></div>
    <div class="status"><i class="dot" id="dot"></i><span id="connection">正在连接…</span></div>
  </header>
  <section class="grid">
    <article class="card"><div class="label">MCP 当前并发</div><div class="value"><span id="mcp-active">—</span> <span class="unit">请求</span></div><div class="detail">本次启动峰值 <span id="mcp-peak">—</span></div></article>
    <article class="card"><div class="label">最近一分钟</div><div class="value"><span id="mcp-rate">—</span> <span class="unit">MCP 请求</span></div><div class="detail">启动后累计 <span id="mcp-total">—</span></div></article>
    <article class="card"><div class="label">进程内存</div><div class="value"><span id="rss">—</span> <span class="unit">MiB RSS</span></div><div class="detail">Heap <span id="heap">—</span> / <span id="heap-total">—</span> MiB</div></article>
    <article class="card"><div class="label">DevSpace CPU</div><div class="value"><span id="cpu">—</span><span class="unit">%</span></div><div class="detail">按一个 CPU 核心的占用计算</div></article>
    <article class="card wide"><div class="label">MCP 请求趋势 · 最近 60 秒</div><div class="chart" id="chart"></div></article>
    <article class="card"><div class="label">后台任务</div><div class="value"><span id="jobs-active">—</span> <span class="unit">/ <span id="jobs-limit">—</span></span></div><div class="detail">历史任务 <span id="jobs-total">—</span></div></article>
    <article class="card"><div class="label">MCP 会话</div><div class="value"><span id="sessions-active">—</span> <span class="unit">活跃</span></div><div class="detail"><span id="transport">—</span> · 高水位 <span id="sessions-peak">—</span></div></article>
  </section>
  <h2 class="section-title">运行诊断</h2>
  <section class="diagnostics">
    <article class="card"><div class="row"><span class="muted">服务运行时间</span><span id="uptime">—</span></div><div class="row"><span class="muted">Boot ID</span><span id="boot">—</span></div><div class="row"><span class="muted">版本</span><span id="version">—</span></div></article>
    <article class="card"><div class="row"><span class="muted">HTTP 当前并发</span><span id="http-active">—</span></div><div class="row"><span class="muted">平均延迟</span><span id="latency">—</span></div><div class="row"><span class="muted">HTTP 错误</span><span id="errors">—</span></div></article>
    <article class="card"><div class="row"><span class="muted">未知 Session</span><span id="unknown">—</span></div><div class="row"><span class="muted">容量回收</span><span id="evictions">—</span></div><div class="row"><span class="muted">关闭错误</span><span id="close-errors">—</span></div></article>
  </section>
  <footer><span>每秒自动刷新 · 监控轮询不计入请求统计</span><span id="updated">尚未更新</span></footer>
  <footer><span class="warning">仅显示 DevSpace 进程总量；stateless 模式无法把内存精确归属到某一个 Web GPT 对话。</span></footer>
</main>
<script>
const byId=(id)=>document.getElementById(id);
const set=(id,value)=>{byId(id).textContent=String(value)};
const duration=(seconds)=>{const s=Math.max(0,Math.floor(seconds));const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+"天 ":"")+(h?h+"小时 ":"")+m+"分钟"};
function renderChart(values){const chart=byId("chart");chart.replaceChildren();const max=Math.max(1,...values);for(const value of values){const bar=document.createElement("i");bar.className="bar"+(value===0?" zero":"");bar.style.height=Math.max(2,Math.round(value/max*100))+"%";bar.title=value+" 请求/秒";chart.appendChild(bar)}}
function render(data){
  const r=data.requests,s=data.sessions,m=data.memory,j=data.jobs;
  set("mcp-active",r.mcp.inFlight);set("mcp-peak",r.mcp.peakInFlight);set("mcp-rate",r.mcp.perMinute);set("mcp-total",r.mcp.total);
  set("rss",m.rssMiB);set("heap",m.heapUsedMiB);set("heap-total",m.heapTotalMiB);set("cpu",data.process.cpuPercent);
  set("jobs-active",j.active);set("jobs-limit",j.maxConcurrent);set("jobs-total",j.total);
  set("sessions-active",s.active);set("sessions-peak",s.highWaterMark);set("transport",s.transportMode);
  set("uptime",duration(data.service.uptimeSeconds));set("boot",data.service.bootId.slice(0,8));set("version",data.service.version);
  set("http-active",r.http.inFlight);set("latency",r.http.averageLatencyMs+" ms");set("errors",r.http.errors);
  set("unknown",s.unknownSessionRequests);set("evictions",s.capacityEvictions);set("close-errors",s.closeErrors);
  renderChart(r.mcpRequestsPerSecond);
  byId("dot").className="dot "+(r.mcp.inFlight||j.active?"busy":"ok");set("connection",r.mcp.inFlight||j.active?"正在工作":"运行正常");
  set("updated","更新于 "+new Date(data.observedAt).toLocaleTimeString());
}
async function refresh(){try{const response=await fetch("/monitor/api",{cache:"no-store"});if(!response.ok)throw new Error("HTTP "+response.status);render(await response.json())}catch(error){byId("dot").className="dot bad";set("connection","连接中断");set("updated",String(error))}}
refresh();setInterval(refresh,1000);
</script>
</body>
</html>`;
}
