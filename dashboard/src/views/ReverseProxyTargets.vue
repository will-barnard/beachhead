<template>
  <div>
    <h2 style="margin-bottom:1rem;">Reverse Proxy Targets</h2>

    <div class="card" style="margin-bottom:1.5rem;">
      <p style="color:var(--muted); font-size:0.9rem; margin:0 0 0.5rem;">
        Forward 80/443 traffic for a domain to a host:port Beachhead does <strong>not</strong> run — e.g. a NAS on
        your LAN. Beachhead terminates TLS (auto-issued and renewed, same as any app) and proxies the decrypted
        request onward to the target over your network.
      </p>
      <p style="color:var(--muted); font-size:0.82rem; margin:0;">
        This routes by domain name, not by blindly forwarding the whole port — the domain must resolve to this
        machine's public IP, same as any other Beachhead app or site.
      </p>
    </div>

    <!-- Add target -->
    <div class="card" style="margin-bottom:1.5rem;">
      <h3 style="margin-bottom:0.75rem;">Add target</h3>
      <div style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.75rem;">
        <div style="flex:1; min-width:160px;">
          <label>Label (optional)</label>
          <input v-model="form.name" placeholder="e.g. Synology NAS" />
        </div>
        <div style="flex:2; min-width:240px;">
          <label>Domain(s)</label>
          <input v-model="form.domains" placeholder="nas.example.com, www.nas.example.com" />
        </div>
      </div>
      <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:flex-end; margin-bottom:0.75rem;">
        <div style="min-width:110px;">
          <label>Scheme</label>
          <select v-model="form.target_scheme">
            <option value="http">http</option>
            <option value="https">https</option>
          </select>
        </div>
        <div style="flex:1; min-width:180px;">
          <label>Target host</label>
          <input v-model="form.target_host" placeholder="192.168.1.50" />
        </div>
        <div style="min-width:110px;">
          <label>Target port</label>
          <input v-model="form.target_port" type="number" min="1" max="65535" placeholder="5000" />
        </div>
        <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.85rem; color:var(--text); width:auto; margin-bottom:0.6rem;">
          <input type="checkbox" v-model="form.websocket" style="width:auto;" /> WebSocket support
        </label>
        <label v-if="form.target_scheme === 'https'"
               style="display:flex; align-items:center; gap:0.4rem; font-size:0.85rem; color:var(--text); width:auto; margin-bottom:0.6rem;">
          <input type="checkbox" v-model="form.verify_tls" style="width:auto;" /> Verify target's TLS cert
        </label>
        <button class="btn" @click="addTarget" :disabled="adding || !canSubmit">
          {{ adding ? 'Adding…' : 'Add' }}
        </button>
      </div>
      <p v-if="form.target_scheme === 'https' && !form.verify_tls" style="color:var(--muted); font-size:0.76rem; margin:0;">
        TLS verification off — use this for a device with a self-signed admin-UI cert (e.g. Synology DSM).
      </p>
      <p v-if="addError" style="color:var(--danger); font-size:0.82rem; margin:0.6rem 0 0;">{{ addError }}</p>
    </div>

    <div v-if="loading" style="color:var(--muted);">Loading…</div>
    <div v-else-if="targets.length === 0" class="card" style="color:var(--muted); font-size:0.9rem;">
      No reverse proxy targets yet.
    </div>

    <div v-for="target in targets" :key="target.id" class="card" style="margin-bottom:1rem;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap;">
        <div style="flex:1; min-width:260px;">
          <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
            <strong v-if="target.name">{{ target.name }}</strong>
            <span :class="['badge', target.enabled ? 'badge-success' : 'badge-warning']" style="font-size:0.65rem;">
              {{ target.enabled ? 'Enabled' : 'Disabled' }}
            </span>
            <span v-if="target.websocket" class="badge badge-info" style="font-size:0.65rem;">WebSocket</span>
            <span v-if="target.target_scheme === 'https' && target.verify_tls === false" class="badge badge-warning" style="font-size:0.65rem;">TLS unverified</span>
          </div>
          <div style="margin-top:0.5rem; display:flex; gap:0.35rem; flex-wrap:wrap;">
            <code v-for="d in target.domains" :key="d" style="font-size:0.8rem; background:var(--surface); padding:0.15rem 0.45rem; border-radius:4px;">{{ d }}</code>
          </div>
          <p style="color:var(--muted); font-size:0.82rem; margin:0.5rem 0 0;">
            → <code>{{ target.target_scheme }}://{{ target.target_host }}:{{ target.target_port }}</code>
          </p>
        </div>

        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
          <button class="btn btn-sm" :disabled="busy === target.id" @click="restart(target)" title="Re-run the proxy container">
            {{ busy === target.id ? '…' : 'Restart' }}
          </button>
          <button class="btn btn-sm" :disabled="busy === target.id" @click="toggleEnabled(target)">
            {{ target.enabled ? 'Disable' : 'Enable' }}
          </button>
          <button class="btn btn-danger btn-sm" :disabled="busy === target.id" @click="remove(target)">×</button>
        </div>
      </div>
      <p v-if="target.warning" style="color:var(--warning); font-size:0.78rem; margin:0.6rem 0 0;">{{ target.warning }}</p>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    targets: [],
    loading: true,
    adding: false,
    addError: null,
    busy: null,
    form: {
      name: '',
      domains: '',
      target_scheme: 'http',
      target_host: '',
      target_port: '',
      websocket: false,
      verify_tls: true,
    },
  }),
  computed: {
    canSubmit() {
      return this.form.domains.trim() && this.form.target_host.trim() && this.form.target_port;
    },
  },
  async mounted() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        this.targets = await api.getReverseProxyTargets();
      } catch (e) {
        this.addError = e.message;
      } finally {
        this.loading = false;
      }
    },
    async addTarget() {
      this.addError = null;
      this.adding = true;
      try {
        await api.createReverseProxyTarget({
          name: this.form.name.trim() || null,
          domains: this.form.domains,
          target_scheme: this.form.target_scheme,
          target_host: this.form.target_host.trim(),
          target_port: Number(this.form.target_port),
          websocket: this.form.websocket,
          verify_tls: this.form.verify_tls,
        });
        this.form = { name: '', domains: '', target_scheme: 'http', target_host: '', target_port: '', websocket: false, verify_tls: true };
        await this.load();
      } catch (e) {
        this.addError = e.message;
      } finally {
        this.adding = false;
      }
    },
    async toggleEnabled(target) {
      this.busy = target.id;
      try {
        await api.enableReverseProxyTarget(target.id, !target.enabled);
        await this.load();
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        this.busy = null;
      }
    },
    async restart(target) {
      this.busy = target.id;
      try {
        await api.restartReverseProxyTarget(target.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        this.busy = null;
      }
    },
    async remove(target) {
      if (!confirm(`Remove reverse proxy target for ${target.domains.join(', ')}?`)) return;
      this.busy = target.id;
      try {
        await api.deleteReverseProxyTarget(target.id);
        await this.load();
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        this.busy = null;
      }
    },
  },
};
</script>
