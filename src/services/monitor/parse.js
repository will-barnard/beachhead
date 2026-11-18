/**
 * Pure parsing and arithmetic for the monitor. No I/O here so it can be unit
 * tested without Docker, Postgres or a Linux /proc (see test/monitor.test.js).
 */

/** /proc/meminfo → bytes. Values in the file are kB. */
function parseMeminfo(text) {
  const kv = {};
  for (const line of String(text).split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal || 0;
  // MemAvailable is the kernel's own estimate of what can be handed out
  // without swapping (free + reclaimable cache). "MemFree" alone would make
  // a healthy host with a warm page cache look permanently full.
  const available = kv.MemAvailable ?? ((kv.MemFree || 0) + (kv.Cached || 0) + (kv.Buffers || 0));
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: Math.max(0, total - available),
    usedPct: total ? round(((total - available) / total) * 100) : 0,
    swapTotalBytes: kv.SwapTotal || 0,
    swapUsedBytes: Math.max(0, (kv.SwapTotal || 0) - (kv.SwapFree || 0)),
    swapUsedPct: kv.SwapTotal ? round((((kv.SwapTotal || 0) - (kv.SwapFree || 0)) / kv.SwapTotal) * 100) : 0,
  };
}

function parseLoadavg(text) {
  const [l1, l5, l15] = String(text).trim().split(/\s+/).map(Number);
  return { load1: l1 || 0, load5: l5 || 0, load15: l15 || 0 };
}

/** First line of /proc/stat → cumulative jiffies. */
function parseProcStat(text) {
  const line = String(text).split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal
  const idle = (n[3] || 0) + (n[4] || 0);
  const total = n.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  return { idle, total };
}

function cpuPctFromProcStat(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  if (dt <= 0) return null;
  return round(((dt - (cur.idle - prev.idle)) / dt) * 100);
}

/**
 * Docker stats JSON → the numbers we keep.
 *
 * prevRaw is this container's previous sample (one-shot stats come back with
 * an empty precpu_stats, so CPU% is computed across our own poll interval —
 * which is also a fairer average than docker's ~1s window).
 *
 * Memory follows the docker CLI: usage minus inactive page cache, otherwise a
 * container that reads a lot of files looks like it's about to OOM.
 */
function normalizeContainerStats(raw, prevRaw, hostMemTotal) {
  const ms = raw.memory_stats || {};
  const st = ms.stats || {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? 0;
  const memBytes = Math.max(0, (ms.usage || 0) - cache);
  const rawLimit = ms.limit || 0;
  // With no mem_limit Docker reports the whole host/VM as the limit.
  const limited = rawLimit > 0 && hostMemTotal > 0 && rawLimit < hostMemTotal * 0.98;
  const memLimitBytes = limited ? rawLimit : hostMemTotal || rawLimit;

  const online = raw.cpu_stats?.online_cpus || raw.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  let cpuPct = null;
  if (prevRaw && prevRaw.cpu_stats && raw.cpu_stats) {
    const cpuDelta = (raw.cpu_stats.cpu_usage?.total_usage || 0) - (prevRaw.cpu_stats.cpu_usage?.total_usage || 0);
    const sysDelta = (raw.cpu_stats.system_cpu_usage || 0) - (prevRaw.cpu_stats.system_cpu_usage || 0);
    if (cpuDelta >= 0 && sysDelta > 0) cpuPct = round((cpuDelta / sysDelta) * online * 100);
  }

  let netRx = 0, netTx = 0;
  for (const iface of Object.values(raw.networks || {})) {
    netRx += iface.rx_bytes || 0;
    netTx += iface.tx_bytes || 0;
  }
  let blkRead = 0, blkWrite = 0;
  for (const e of raw.blkio_stats?.io_service_bytes_recursive || []) {
    const op = String(e.op || '').toLowerCase();
    if (op === 'read') blkRead += e.value || 0;
    if (op === 'write') blkWrite += e.value || 0;
  }

  return {
    cpuPct,                                   // % of one core, docker-style (can exceed 100)
    cpuPctOfHost: cpuPct == null ? null : round(cpuPct / online),
    memBytes,
    memLimitBytes,
    memPct: memLimitBytes ? round((memBytes / memLimitBytes) * 100) : 0,
    memLimited: limited,
    netRxBytes: netRx,
    netTxBytes: netTx,
    blkReadBytes: blkRead,
    blkWriteBytes: blkWrite,
    pids: raw.pids_stats?.current || 0,
  };
}

/**
 * Least-squares fit over [{t: ms, v}] → { slopePerMs, intercept }.
 * Used for "disk full in N days" and memory-leak detection; deliberately
 * simple — a straight line over a day is the right level of honesty for a
 * projection like this.
 */
function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  const t0 = points[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const x = p.t - t0;
    sx += x; sy += p.v; sxx += x * x; sxy += x * p.v;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // R² — how much of the movement the line explains. Leak detection only
  // trusts a steady climb, not a sawtooth that happens to trend upward.
  const mean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    const pred = intercept + slope * (p.t - t0);
    ssTot += (p.v - mean) ** 2;
    ssRes += (p.v - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slopePerMs: slope, intercept, t0, r2 };
}

/**
 * Hours until the fitted line reaches `target`, from the last point.
 * null when the trend is flat/downward or there isn't enough span to trust.
 */
function hoursUntil(points, target, { minSpanMs = 3 * 3600 * 1000, minR2 = 0 } = {}) {
  if (points.length < 6) return null;
  const span = points[points.length - 1].t - points[0].t;
  if (span < minSpanMs) return null;
  const fit = linearFit(points);
  if (!fit || fit.slopePerMs <= 0 || fit.r2 < minR2) return null;
  const last = points[points.length - 1];
  const current = fit.intercept + fit.slopePerMs * (last.t - fit.t0);
  if (current >= target) return 0;
  return round((target - current) / fit.slopePerMs / 3600000);
}

/**
 * Exit codes that mean "something stopped this on purpose": 0 (clean),
 * 143 (SIGTERM — docker stop / compose down), 137 (SIGKILL after the stop
 * timeout). OOM kills are also 137 but arrive as their own `oom` event,
 * which is handled separately, so treating 137 as intentional here doesn't
 * hide them.
 */
function isUnexpectedExit(exitCode) {
  const c = Number(exitCode);
  return !Number.isNaN(c) && ![0, 137, 143].includes(c);
}

function round(n, places = 1) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

module.exports = {
  parseMeminfo,
  parseLoadavg,
  parseProcStat,
  cpuPctFromProcStat,
  normalizeContainerStats,
  linearFit,
  hoursUntil,
  isUnexpectedExit,
  round,
};
