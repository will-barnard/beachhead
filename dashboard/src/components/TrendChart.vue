<template>
  <div class="trend">
    <div class="trend-head">
      <span class="trend-title">{{ title }}</span>
      <span v-if="last != null" class="trend-now">{{ fmt(last) }}</span>
    </div>
    <div ref="box" class="trend-box" :style="{ height: height + 'px' }"
         @mousemove="onMove" @mouseleave="hoverIdx = null">
      <svg v-if="width > 0" :width="width" :height="height" role="img" :aria-label="ariaLabel">
        <!-- recessive solid hairline grid -->
        <g>
          <line v-for="t in yTicks" :key="'g' + t" :x1="padL" :x2="width - padR" :y1="y(t)" :y2="y(t)" class="grid" />
          <text v-for="t in yTicks" :key="'l' + t" :x="padL - 6" :y="y(t) + 3" class="tick" text-anchor="end">{{ fmtTick(t) }}</text>
        </g>
        <!-- threshold reference: annotation, not data -->
        <g v-if="threshold != null && threshold <= yMax">
          <line :x1="padL" :x2="width - padR" :y1="y(threshold)" :y2="y(threshold)" class="threshold" />
          <text :x="padL + 4" :y="y(threshold) - 4" class="tick">{{ thresholdLabel }} {{ fmtTick(threshold) }}</text>
        </g>
        <template v-if="pts.length > 1">
          <path :d="areaPath" class="area" />
          <path :d="linePath" class="line" />
          <circle :cx="x(pts[pts.length - 1].t)" :cy="y(pts[pts.length - 1].v)" r="4" class="dot" />
        </template>
        <text v-if="pts.length" :x="padL" :y="height - 4" class="tick">{{ fmtTime(pts[0].t) }}</text>
        <text v-if="pts.length" :x="width - padR" :y="height - 4" class="tick" text-anchor="end">{{ fmtTime(pts[pts.length - 1].t) }}</text>
        <!-- crosshair -->
        <g v-if="hover">
          <line :x1="x(hover.t)" :x2="x(hover.t)" :y1="padT" :y2="height - padB" class="cross" />
          <circle :cx="x(hover.t)" :cy="y(hover.v)" r="4" class="dot" />
        </g>
      </svg>
      <div v-if="hover" class="tip" :style="tipStyle">
        <strong>{{ fmt(hover.v) }}</strong><br><span>{{ fmtTime(hover.t, true) }}</span>
      </div>
      <div v-if="!pts.length" class="empty">{{ emptyText }}</div>
    </div>
    <details class="trend-table">
      <summary>Data</summary>
      <table>
        <tr><th>Time</th><th>{{ title }}</th></tr>
        <tr v-for="p in tableRows" :key="p.t"><td>{{ fmtTime(p.t, true) }}</td><td>{{ fmt(p.v) }}</td></tr>
      </table>
    </details>
  </div>
</template>

<script>
/**
 * Single-series time chart: 2px line, 10% area wash, end dot with a surface
 * ring, hairline grid, optional alert-threshold reference line, crosshair +
 * tooltip on hover, and a collapsible table of the values for anyone who
 * can't read the chart. One series per chart on purpose — memory, CPU and
 * disk have different units, so they get separate charts, never two y-axes.
 */
export default {
  props: {
    title: { type: String, required: true },
    points: { type: Array, default: () => [] },  // [{ t: ms, v: number|null }]
    unit: { type: String, default: '%' },         // '%' | 'bytes' | 'x' | ''
    max: { type: Number, default: null },          // fixed y max (100 for %); else auto
    threshold: { type: Number, default: null },
    thresholdLabel: { type: String, default: 'alert' },
    height: { type: Number, default: 140 },
    emptyText: { type: String, default: 'No samples yet — the collector runs once a minute.' },
  },
  data: () => ({ width: 0, hoverIdx: null, padR: 8, padT: 10, padB: 18 }),
  computed: {
    // Byte labels ("512 MB") need more room than percentages.
    padL() { return this.unit === 'bytes' ? 56 : 44; },
    pts() { return this.points.filter((p) => p.v != null && Number.isFinite(p.v)); },
    last() { return this.pts.length ? this.pts[this.pts.length - 1].v : null; },
    tMin() { return this.pts.length ? this.pts[0].t : 0; },
    tMax() { return this.pts.length ? this.pts[this.pts.length - 1].t : 1; },
    yMax() {
      if (this.max != null) return this.max;
      const m = Math.max(0, ...this.pts.map((p) => p.v), this.threshold || 0) || 1;
      if (this.unit === 'bytes') {
        // Round in the unit the axis will print (MB, GB), so ticks read
        // 0 / 500 MB / 1 GB rather than 0 / 477 MB / 954 MB.
        const base = 1024 ** Math.max(0, Math.floor(Math.log(m) / Math.log(1024)));
        const n = niceCeil(m / base);
        // 1000 MB is better read as 1 GB.
        return n >= 1000 ? 1024 * base : n * base;
      }
      return niceCeil(m);
    },
    yTicks() { return [0, this.yMax / 2, this.yMax]; },
    linePath() { return this.pts.map((p, i) => `${i ? 'L' : 'M'}${this.x(p.t).toFixed(1)},${this.y(p.v).toFixed(1)}`).join(''); },
    areaPath() {
      if (this.pts.length < 2) return '';
      const base = this.y(0).toFixed(1);
      return `${this.linePath}L${this.x(this.tMax).toFixed(1)},${base}L${this.x(this.tMin).toFixed(1)},${base}Z`;
    },
    hover() { return this.hoverIdx == null ? null : this.pts[this.hoverIdx]; },
    tipStyle() {
      if (!this.hover) return {};
      const left = this.x(this.hover.t);
      return { left: `${Math.min(Math.max(left, 60), this.width - 60)}px`, top: '0px' };
    },
    tableRows() {
      // Keep the table readable: at most ~24 evenly spaced rows.
      const step = Math.max(1, Math.ceil(this.pts.length / 24));
      return this.pts.filter((_, i) => i % step === 0 || i === this.pts.length - 1).slice().reverse();
    },
    ariaLabel() {
      return `${this.title}: ${this.last == null ? 'no data' : `currently ${this.fmt(this.last)}`}`;
    },
  },
  mounted() {
    this.measure();
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(this.$refs.box);
  },
  beforeUnmount() { this.ro?.disconnect(); },
  methods: {
    measure() { this.width = this.$refs.box?.clientWidth || 0; },
    x(t) {
      const span = this.tMax - this.tMin || 1;
      return this.padL + ((t - this.tMin) / span) * (this.width - this.padL - this.padR);
    },
    y(v) {
      const h = this.height - this.padT - this.padB;
      return this.padT + h - (Math.min(v, this.yMax) / (this.yMax || 1)) * h;
    },
    onMove(e) {
      if (!this.pts.length) return;
      const rect = this.$refs.box.getBoundingClientRect();
      const px = e.clientX - rect.left;
      // Snap to the nearest sample on X — the pointer never has to be on the line.
      let best = 0, bestD = Infinity;
      this.pts.forEach((p, i) => { const d = Math.abs(this.x(p.t) - px); if (d < bestD) { bestD = d; best = i; } });
      this.hoverIdx = best;
    },
    fmt(v) {
      if (v == null) return '—';
      if (this.unit === 'bytes') return fmtBytes(v);
      if (this.unit === '%') return `${Math.round(v * 10) / 10}%`;
      if (this.unit === 'x') return `${Math.round(v * 100) / 100}×`;
      return String(Math.round(v * 10) / 10);
    },
    fmtTick(v) {
      if (this.unit === 'bytes') return fmtBytes(v);
      if (this.unit === '%') return `${Math.round(v)}%`;
      return String(Math.round(v * 10) / 10);
    },
    fmtTime(t, full = false) {
      const d = new Date(t);
      const span = this.tMax - this.tMin;
      if (full || span > 36 * 3600e3) return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
  },
};

function niceCeil(n) {
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
</script>

<style scoped>
.trend { min-width: 0; }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.25rem; }
.trend-title { font-size: 0.8rem; color: var(--muted); }
.trend-now { font-size: 0.95rem; font-weight: 600; color: var(--text); }
.trend-box { position: relative; width: 100%; }
.grid { stroke: var(--border); stroke-width: 1; }
.threshold { stroke: var(--muted); stroke-width: 1; opacity: 0.6; }
.tick { fill: var(--muted); font-size: 10px; }
.line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.area { fill: var(--accent); opacity: 0.1; }
.dot { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.cross { stroke: var(--muted); stroke-width: 1; }
.tip {
  position: absolute; transform: translate(-50%, 0); pointer-events: none; z-index: 1;
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 0.25rem 0.5rem; font-size: 0.75rem; white-space: nowrap; color: var(--text);
}
.tip span { color: var(--muted); }
.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; color: var(--muted); text-align: center; padding: 0 1rem; }
.trend-table { margin-top: 0.25rem; font-size: 0.75rem; color: var(--muted); }
.trend-table summary { cursor: pointer; }
.trend-table table { width: 100%; border-collapse: collapse; margin-top: 0.25rem; }
.trend-table th, .trend-table td { text-align: left; padding: 0.125rem 0.25rem; border-bottom: 1px solid var(--border); }
</style>
