<template>
  <div>
    <!-- Header -->
    <div class="head">
      <div>
        <h2 style="display:flex; align-items:center; gap:0.6rem;">
          Health
          <span v-if="snap" class="badge" :class="statusBadge.cls">{{ statusBadge.icon }} {{ statusBadge.text }}</span>
        </h2>
        <div v-if="snap" class="muted small">
          {{ snap.instance.name }}
          <template v-if="snap.instance.docker"> · Docker {{ snap.instance.docker.version }} on {{ snap.instance.docker.os }}</template>
          · checked {{ ago(snap.checkedAt) }}
        </div>
      </div>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn" @click="runNow" :disabled="running">{{ running ? 'Checking…' : 'Check now' }}</button>
        <button class="btn" style="background:var(--border);" @click="showSettings = !showSettings">⚙ Alert settings</button>
      </div>
    </div>

    <div v-if="error" class="card" style="color:var(--danger);">{{ error }}</div>
    <div v-if="snap && Object.keys(snap.collector.errors || {}).length" class="card small" style="color:var(--warning);">
      Some checks failed on the last run:
      <span v-for="(msg, k) in snap.collector.errors" :key="k" style="margin-right:1rem;"><code>{{ k }}</code> {{ msg }}</span>
    </div>

    <!-- Alert settings -->
    <div v-if="showSettings && cfg" class="card">
      <h3 class="h3">Alert email</h3>
      <p class="muted small" style="margin-bottom:0.75rem;">
        Sent through Resend. The sender's domain must be verified in your Resend account.
        Alerts are batched into one email per 30 seconds, at most 12 an hour.
      </p>
      <div class="grid2">
        <div class="form-group">
          <label><input type="checkbox" v-model="cfg.email.enabled" style="width:auto; margin-right:0.4rem;">Email alerts on</label>
        </div>
        <div class="form-group">
          <label>Send for</label>
          <select v-model="cfg.email.minSeverity">
            <option value="warning">Warnings and critical</option>
            <option value="critical">Critical only</option>
          </select>
        </div>
        <div class="form-group">
          <label>Resend API key</label>
          <input v-model="cfg.email.apiKey" type="password" placeholder="re_…" autocomplete="off">
        </div>
        <div class="form-group">
          <label>From</label>
          <input v-model="cfg.email.from" placeholder="Beachhead <alerts@yourdomain.com>">
        </div>
        <div class="form-group" style="grid-column: 1 / -1;">
          <label>To (comma-separated)</label>
          <input v-model="cfg.email.to" placeholder="you@example.com">
        </div>
      </div>

      <h3 class="h3" style="margin-top:1rem;">Instance</h3>
      <div class="grid2">
        <div class="form-group">
          <label>Name (shown in emails and, later, in Cabana)</label>
          <input v-model="cfg.instanceName" :placeholder="snap?.instance.domain || 'mac-mini'">
        </div>
        <div class="form-group">
          <label>Heartbeat URL (optional)</label>
          <input v-model="cfg.heartbeatUrl" placeholder="https://hc-ping.com/…">
          <div class="muted small" style="margin-top:0.25rem;">
            Pinged every minute while checks pass. Point it at healthchecks.io (or similar) and it emails you when the pings stop — the one alert this machine can't send about itself.
          </div>
        </div>
      </div>

      <h3 class="h3" style="margin-top:1rem;">Thresholds</h3>
      <table class="tbl">
        <thead><tr><th>Check</th><th>Warning</th><th>Critical</th><th title="Consecutive minutes before alerting">Minutes</th><th>On</th></tr></thead>
        <tbody>
          <tr v-for="r in ruleList" :key="r.id">
            <td>{{ r.label }}</td>
            <template v-if="r.direction">
              <td><input class="num" v-model.number="r.warn" type="number" step="any" min="0"> <span class="muted small">{{ r.unit }}</span></td>
              <td><input class="num" v-model.number="r.crit" type="number" step="any" min="0" :placeholder="'—'"> <span class="muted small">{{ r.unit }}</span></td>
              <td><input class="num" v-model.number="r.forTicks" type="number" min="1"></td>
            </template>
            <template v-else>
              <td colspan="3" class="muted small">{{ r.severity === 'critical' ? 'Always critical' : 'Always a warning' }}</td>
            </template>
            <td><input type="checkbox" v-model="r.enabled" style="width:auto;"></td>
          </tr>
        </tbody>
      </table>
      <div style="display:flex; gap:0.5rem; margin-top:1rem; align-items:center;">
        <button class="btn" @click="saveConfig" :disabled="savingCfg">{{ savingCfg ? 'Saving…' : 'Save' }}</button>
        <button class="btn" style="background:var(--border);" @click="testEmail" :disabled="testing">{{ testing ? 'Sending…' : 'Send test email' }}</button>
        <span v-if="cfgMsg" class="small" :style="{ color: cfgMsgErr ? 'var(--danger)' : 'var(--success)' }">{{ cfgMsg }}</span>
      </div>
    </div>

    <template v-if="snap">
      <!-- Open alerts -->
      <div class="card">
        <h3 class="h3">Open alerts <span class="muted small" v-if="snap.alerts.open.length">({{ snap.alerts.open.length }})</span></h3>
        <div v-if="!snap.alerts.open.length" class="muted small">✓ Nothing needs attention.</div>
        <div v-for="a in sortedOpen" :key="a.id" class="alert-row">
          <span class="badge" :class="a.severity === 'critical' ? 'badge-danger' : 'badge-warning'">{{ a.severity === 'critical' ? '✕ Critical' : '⚠ Warning' }}</span>
          <span class="alert-msg">{{ a.message }}</span>
          <span class="muted small">{{ ago(a.openedAt) }}</span>
          <button class="btn btn-sm" style="background:var(--border);" title="Dismiss — it reopens if the problem is still there" @click="resolve(a)">Dismiss</button>
        </div>
      </div>

      <!-- Host & disks -->
      <div class="tiles">
        <div class="card tile" v-if="d.host">
          <div class="tile-label">Memory</div>
          <div class="tile-value">{{ d.host.usedPct }}%</div>
          <meter-bar :value="d.host.usedPct" :rule="rules.host_memory" />
          <div class="muted small">{{ bytes(d.host.usedBytes) }} of {{ bytes(d.host.totalBytes) }}</div>
        </div>
        <div class="card tile" v-if="d.host">
          <div class="tile-label">CPU</div>
          <div class="tile-value">{{ d.host.cpuPct == null ? '—' : d.host.cpuPct + '%' }}</div>
          <meter-bar :value="d.host.cpuPct || 0" />
          <div class="muted small">load {{ d.host.load5 }} on {{ d.host.ncpu }} cores ({{ d.host.loadPerCore }}× per core)</div>
        </div>
        <div class="card tile" v-if="d.host && d.host.swapTotalBytes > 0">
          <div class="tile-label">Swap</div>
          <div class="tile-value">{{ d.host.swapUsedPct }}%</div>
          <meter-bar :value="d.host.swapUsedPct" :rule="rules.host_swap" />
          <div class="muted small">{{ bytes(d.host.swapUsedBytes) }} of {{ bytes(d.host.swapTotalBytes) }}</div>
        </div>
        <div class="card tile" v-for="disk in d.disks" :key="disk.label">
          <div class="tile-label">{{ disk.label === 'docker' ? 'Docker storage' : 'Deploy directory' }}</div>
          <div class="tile-value">{{ disk.usedPct }}%</div>
          <meter-bar :value="disk.usedPct" :rule="rules.disk_used" />
          <div class="muted small">
            {{ bytes(disk.freeBytes) }} free of {{ bytes(disk.totalBytes) }}
            <template v-if="disk.daysLeft != null"> · full in ~{{ disk.daysLeft }} days</template>
          </div>
        </div>
      </div>
      <p v-if="isDockerDesktop" class="muted small" style="margin:-0.25rem 0 1rem;">
        On Docker Desktop these are the Docker VM's limits (Settings → Resources), which is the ceiling containers hit — not the Mac's own RAM and disk.
      </p>

      <!-- Trends -->
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
          <h3 class="h3" style="margin:0;">Trends</h3>
          <div class="seg">
            <button v-for="r in ranges" :key="r" :class="{ on: range === r }" @click="setRange(r)">{{ r }}</button>
          </div>
        </div>
        <div class="trends">
          <trend-chart title="Memory used" :points="series.mem" unit="%" :max="100" :threshold="rules.host_memory?.enabled ? rules.host_memory.warn : null" />
          <trend-chart title="CPU" :points="series.cpu" unit="%" :max="100" />
          <trend-chart title="Docker storage used" :points="series.disk" unit="%" :max="100" :threshold="rules.disk_used?.enabled ? rules.disk_used.warn : null" />
        </div>
      </div>

      <!-- Containers -->
      <div class="card">
        <h3 class="h3">Containers
          <span class="muted small">{{ snap.containers.running }} running of {{ snap.containers.total }}<template v-if="snap.containers.unhealthy"> · {{ snap.containers.unhealthy }} unhealthy</template></span>
        </h3>
        <div style="overflow-x:auto;">
          <table class="tbl">
            <thead>
              <tr>
                <th>Container</th><th>App</th><th>State</th>
                <th class="r sortable" @click="sortBy = 'cpu'">CPU{{ sortBy === 'cpu' ? ' ↓' : '' }}</th>
                <th class="r sortable" @click="sortBy = 'mem'">Memory{{ sortBy === 'mem' ? ' ↓' : '' }}</th>
                <th class="r">Limit</th><th class="r">PIDs</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="c in sortedContainers" :key="c.id">
                <tr class="clickable" @click="toggleContainer(c)">
                  <td><code>{{ c.name }}</code></td>
                  <td class="muted">{{ c.appName || ownerLabel(c.owner) }}</td>
                  <td>
                    <span class="badge" :class="stateClass(c)">{{ c.health === 'unhealthy' ? '⚠ unhealthy' : c.state }}</span>
                  </td>
                  <td class="r">{{ c.stats?.cpuPct == null ? '—' : c.stats.cpuPct + '%' }}</td>
                  <td class="r">{{ c.stats ? bytes(c.stats.memBytes) : '—' }}</td>
                  <td class="r muted">
                    <template v-if="c.stats?.memLimited">{{ c.stats.memPct }}% of {{ bytes(c.stats.memLimitBytes) }}</template>
                    <template v-else-if="c.stats">none</template>
                  </td>
                  <td class="r muted">{{ c.stats?.pids ?? '—' }}</td>
                </tr>
                <tr v-if="openContainer === c.name">
                  <td colspan="7" style="padding:0.75rem 0.5rem;">
                    <div class="trends">
                      <trend-chart :title="`${c.name} memory`" :points="containerSeries.mem" unit="bytes"
                                   :threshold="c.stats?.memLimited ? c.stats.memLimitBytes : null" threshold-label="limit" />
                      <trend-chart :title="`${c.name} CPU (% of one core)`" :points="containerSeries.cpu" unit="%" />
                    </div>
                    <div class="muted small" style="margin-top:0.25rem;">{{ c.status }} · image {{ c.image }}</div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p class="muted small" style="margin-top:0.5rem;">
          Containers with no memory limit can use the whole host. Set one per service with
          <code>"resources"</code> in <code>beachhead.json</code>.
        </p>
      </div>

      <div class="grid2">
        <!-- Docker disk -->
        <div class="card" v-if="d.dockerDf">
          <h3 class="h3">Docker disk use <span class="muted small">as of {{ ago(d.dockerDf.at) }}</span></h3>
          <table class="tbl">
            <thead><tr><th>Type</th><th class="r">Size</th><th class="r">Reclaimable</th></tr></thead>
            <tbody>
              <tr><td>Images ({{ d.dockerDf.images.count }})</td><td class="r">{{ bytes(d.dockerDf.images.bytes) }}</td><td class="r">{{ bytes(d.dockerDf.images.reclaimableBytes) }}</td></tr>
              <tr><td>Build cache</td><td class="r">{{ bytes(d.dockerDf.buildCache.bytes) }}</td><td class="r">{{ bytes(d.dockerDf.buildCache.reclaimableBytes) }}</td></tr>
              <tr><td>Volumes ({{ d.dockerDf.volumes.count }})</td><td class="r">{{ bytes(d.dockerDf.volumes.bytes) }}</td><td class="r">{{ bytes(d.dockerDf.volumes.reclaimableBytes) }}</td></tr>
              <tr><td>Container layers</td><td class="r">{{ bytes(d.dockerDf.containers.bytes) }}</td><td class="r muted">—</td></tr>
            </tbody>
          </table>
          <div v-if="d.dockerDf.volumes.largest.length" style="margin-top:0.75rem;">
            <div class="muted small" style="margin-bottom:0.25rem;">Largest volumes</div>
            <div v-for="v in d.dockerDf.volumes.largest" :key="v.name" class="kv small">
              <code>{{ v.name }}</code><span>{{ bytes(v.bytes) }}<span v-if="!v.inUse" class="muted"> · unused</span></span>
            </div>
          </div>
          <p class="muted small" style="margin-top:0.75rem;">Reclaim space under <router-link to="/settings">Settings → Docker Disk Cleanup</router-link>.</p>
        </div>

        <!-- Apps & certs -->
        <div class="card">
          <h3 class="h3">App checks</h3>
          <div v-if="!d.probes.length" class="muted small">No live apps probed yet (runs every 2 minutes; paused apps are skipped).</div>
          <div v-for="p in d.probes" :key="p.appId" class="kv small">
            <span><span :style="{ color: p.ok ? 'var(--success)' : 'var(--danger)' }">{{ p.ok ? '✓' : '✕' }}</span> {{ p.host }}{{ p.path !== '/' ? p.path : '' }}</span>
            <span class="muted">{{ p.error || `HTTP ${p.status}` }} · {{ p.ms }} ms</span>
          </div>
          <h3 class="h3" style="margin-top:1rem;">Certificates</h3>
          <div v-if="!d.certs.length" class="muted small">Checked every 6 hours — first check runs a couple of minutes after start.</div>
          <div v-for="c in d.certs" :key="c.hosts[0]" class="kv small">
            <span>{{ c.hosts.join(', ') }}</span>
            <span :class="certClass(c)">{{ c.error ? 'unreadable' : `${c.daysLeft} days` }}</span>
          </div>
        </div>
      </div>

      <!-- History -->
      <div class="card">
        <h3 class="h3">Resolved alerts <span class="muted small">last 50</span></h3>
        <div v-if="!history.length" class="muted small">None yet.</div>
        <table v-else class="tbl">
          <thead><tr><th>Severity</th><th>Alert</th><th>Opened</th><th>Resolved</th></tr></thead>
          <tbody>
            <tr v-for="a in history" :key="a.id">
              <td><span class="badge" :class="a.severity === 'critical' ? 'badge-danger' : 'badge-warning'">{{ a.severity === 'critical' ? '✕ Critical' : '⚠ Warning' }}</span></td>
              <td>{{ a.message }}</td>
              <td class="muted small">{{ when(a.opened_at) }}</td>
              <td class="muted small">{{ when(a.resolved_at) }}{{ a.resolved_by === 'manual' ? ' (dismissed)' : a.resolved_by && a.resolved_by !== 'auto' ? ` (dismissed by ${a.resolved_by})` : '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <div v-else-if="!error" class="muted">Loading…</div>
  </div>
</template>

<script>
import api from '../api.js';
import TrendChart from '../components/TrendChart.vue';
import MeterBar from '../components/MeterBar.vue';

const POLL_MS = 30_000;

export default {
  components: { TrendChart, MeterBar },
  data: () => ({
    snap: null,
    cfg: null,
    savedRules: {},
    history: [],
    error: null,
    running: false,
    showSettings: false,
    savingCfg: false,
    testing: false,
    cfgMsg: '',
    cfgMsgErr: false,
    ranges: ['1h', '6h', '24h', '7d', '30d'],
    range: '6h',
    series: { mem: [], cpu: [], disk: [] },
    openContainer: null,
    containerSeries: { mem: [], cpu: [] },
    sortBy: 'mem',
    timer: null,
  }),
  computed: {
    d() { return this.snap?.detail || { host: null, disks: [], containers: [], probes: [], certs: [] }; },
    // Meters and chart thresholds follow the *saved* rules, not the form.
    rules() { return this.savedRules; },
    ruleList() { return Object.values(this.cfg?.rules || {}); },
    isDockerDesktop() { return /docker desktop/i.test(this.snap?.instance.docker?.os || ''); },
    statusBadge() {
      const s = this.snap?.status;
      if (s === 'critical') return { cls: 'badge-danger', icon: '✕', text: 'Critical' };
      if (s === 'degraded') return { cls: 'badge-warning', icon: '⚠', text: 'Degraded' };
      if (s === 'ok') return { cls: 'badge-success', icon: '✓', text: 'Healthy' };
      return { cls: 'badge-warning', icon: '?', text: 'No recent data' };
    },
    sortedOpen() {
      return [...this.snap.alerts.open].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
    },
    sortedContainers() {
      const key = this.sortBy === 'cpu' ? (c) => c.stats?.cpuPct ?? -1 : (c) => c.stats?.memBytes ?? -1;
      // Problems first, then by the chosen metric.
      const rank = (c) => (c.health === 'unhealthy' ? 0 : c.state === 'running' ? 1 : 2);
      return [...this.d.containers].sort((a, b) => rank(a) - rank(b) || key(b) - key(a));
    },
  },
  async created() {
    await Promise.all([this.load(), this.loadConfig(), this.loadSeries(), this.loadHistory()]);
    this.timer = setInterval(() => { this.load(); this.loadHistory(); }, POLL_MS);
  },
  beforeUnmount() { clearInterval(this.timer); },
  methods: {
    async load() {
      try {
        this.snap = await api.getMonitorSnapshot();
        this.error = null;
      } catch (e) { this.error = e.message; }
    },
    async loadConfig() {
      try {
        const c = await api.getMonitorConfig();
        this.savedRules = JSON.parse(JSON.stringify(c.rules));
        this.cfg = c;
      } catch (e) { this.error = e.message; }
    },
    async loadHistory() {
      try { this.history = await api.getMonitorAlerts('resolved', 50); } catch { /* non-fatal */ }
    },
    async loadSeries() {
      try {
        const [host, disk] = await Promise.all([
          api.getMonitorMetrics('host', 'host', this.range),
          api.getMonitorMetrics('disk', 'docker', this.range),
        ]);
        this.series = {
          mem: host.points.map((p) => ({ t: p.t, v: p.usedPct })),
          cpu: host.points.map((p) => ({ t: p.t, v: p.cpuPct })),
          disk: disk.points.map((p) => ({ t: p.t, v: p.usedPct })),
        };
      } catch { /* charts show their empty state */ }
    },
    setRange(r) {
      this.range = r;
      this.loadSeries();
      if (this.openContainer) this.loadContainerSeries(this.openContainer);
    },
    async toggleContainer(c) {
      if (this.openContainer === c.name) { this.openContainer = null; return; }
      this.openContainer = c.name;
      this.containerSeries = { mem: [], cpu: [] };
      await this.loadContainerSeries(c.name);
    },
    async loadContainerSeries(name) {
      try {
        const m = await api.getMonitorMetrics('container', name, this.range);
        this.containerSeries = {
          mem: m.points.map((p) => ({ t: p.t, v: p.memBytes })),
          cpu: m.points.map((p) => ({ t: p.t, v: p.cpuPct })),
        };
      } catch { /* empty state */ }
    },
    async runNow() {
      this.running = true;
      try {
        await api.runMonitor();
        await Promise.all([this.load(), this.loadSeries(), this.loadHistory()]);
      } catch (e) { this.error = e.message; }
      finally { this.running = false; }
    },
    async resolve(a) {
      try {
        await api.resolveMonitorAlert(a.id);
        await Promise.all([this.load(), this.loadHistory()]);
      } catch (e) { alert('Failed: ' + e.message); }
    },
    async saveConfig() {
      this.savingCfg = true;
      this.cfgMsg = '';
      try {
        const rules = {};
        for (const r of this.ruleList) rules[r.id] = { warn: r.warn, crit: r.crit, forTicks: r.forTicks, enabled: r.enabled };
        await api.updateMonitorConfig({ instanceName: this.cfg.instanceName, heartbeatUrl: this.cfg.heartbeatUrl, email: this.cfg.email, rules });
        await this.loadConfig();
        this.cfgMsg = 'Saved';
        this.cfgMsgErr = false;
      } catch (e) {
        this.cfgMsg = e.message;
        this.cfgMsgErr = true;
      } finally { this.savingCfg = false; }
    },
    async testEmail() {
      this.testing = true;
      this.cfgMsg = '';
      try {
        await api.testMonitorEmail();
        this.cfgMsg = `Test sent to ${this.cfg.email.to || 'the configured address'} — save first if you just changed settings.`;
        this.cfgMsgErr = false;
      } catch (e) {
        this.cfgMsg = e.message;
        this.cfgMsgErr = true;
      } finally { this.testing = false; }
    },
    stateClass(c) {
      if (c.health === 'unhealthy') return 'badge-warning';
      if (c.state === 'running') return 'badge-success';
      if (c.state === 'exited' || c.state === 'dead') return 'badge-danger';
      return 'badge-warning';
    },
    ownerLabel(o) {
      return { beachhead: 'Beachhead', 'static-site': 'Static site', stateful: 'Stateful', app: 'App' }[o] || '—';
    },
    certClass(c) {
      if (c.error || c.daysLeft <= (this.rules.cert_expiry?.crit ?? 5)) return 'danger';
      if (c.daysLeft <= (this.rules.cert_expiry?.warn ?? 14)) return 'warning';
      return 'muted';
    },
    bytes(n) {
      if (n == null) return '—';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0; let v = n;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
    },
    ago(iso) {
      if (!iso) return 'never';
      const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return `${Math.max(0, s)}s ago`;
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      if (s < 86400) return `${Math.round(s / 3600)}h ago`;
      return `${Math.round(s / 86400)}d ago`;
    },
    when(iso) {
      return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },
  },
};
</script>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; gap: 1rem; }
.muted { color: var(--muted); }
.small { font-size: 0.8rem; }
.danger { color: var(--danger); }
.warning { color: var(--warning); }
.h3 { font-size: 0.95rem; margin-bottom: 0.75rem; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.tile { margin-bottom: 0; }
.tile-label { font-size: 0.8rem; color: var(--muted); }
.tile-value { font-size: 1.6rem; font-weight: 600; line-height: 1.2; }
.trends { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.25rem; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0 1rem; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.seg button { background: transparent; color: var(--muted); border: none; padding: 0.25rem 0.6rem; font-size: 0.78rem; cursor: pointer; }
.seg button.on { background: var(--accent); color: #fff; }
.tbl { width: 100%; font-size: 0.8rem; border-collapse: collapse; }
.tbl th { text-align: left; color: var(--muted); font-weight: 500; padding: 0.375rem 0.5rem; border-bottom: 1px solid var(--border); }
.tbl td { padding: 0.375rem 0.5rem; border-bottom: 1px solid var(--border); }
.tbl .r { text-align: right; }
.tbl .num { width: 5rem; padding: 0.25rem 0.4rem; }
.sortable { cursor: pointer; user-select: none; }
.clickable { cursor: pointer; }
.clickable:hover td { background: rgba(255, 255, 255, 0.02); }
.alert-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.45rem 0; border-bottom: 1px solid var(--border); }
.alert-row:last-child { border-bottom: none; }
.alert-msg { flex: 1; font-size: 0.875rem; }
.kv { display: flex; justify-content: space-between; gap: 1rem; padding: 0.3rem 0; border-bottom: 1px solid var(--border); }
.kv:last-child { border-bottom: none; }
</style>
