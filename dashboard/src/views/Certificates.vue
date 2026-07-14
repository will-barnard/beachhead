<template>
  <div>
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:1rem;">
      <h2 style="margin:0;">Certificates</h2>
      <button class="btn btn-sm" @click="runDiagnostics" :disabled="diagLoading">
        {{ diagLoading ? '…' : 'Diagnostics' }}
      </button>
    </div>

    <div v-if="diag" class="card" style="margin-bottom:1rem;">
      <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.5rem;">
        <strong style="font-size:0.9rem;">acme-companion</strong>
        <span :class="['badge', diag.reachable ? 'badge-success' : 'badge-warning']" style="font-size:0.65rem;">
          {{ diag.reachable ? 'reachable' : 'unreachable' }}
        </span>
        <span style="color:var(--muted); font-size:0.78rem;">{{ diag.container }}</span>
        <button class="btn btn-sm" style="margin-left:auto;" @click="diag = null">Hide</button>
      </div>
      <p style="color:var(--muted); font-size:0.78rem; margin:0 0 0.4rem;">
        This is exactly what acme-companion currently has for standalone certs. Each hostname you added should appear in an <code>ACME_..._HOST</code> line.
      </p>
      <pre style="background:var(--surface); padding:0.6rem; border-radius:4px; font-size:0.75rem; overflow:auto; margin:0;">{{ diag.content || '(empty — no standalone certs delivered yet)' }}</pre>
    </div>

    <div v-if="notice" class="card" style="margin-bottom:1rem; border-left:3px solid var(--warning, #e0b341);">
      <span style="font-size:0.85rem;">{{ notice }}</span>
      <button class="btn btn-sm" style="margin-left:0.75rem;" @click="notice = null">Dismiss</button>
    </div>

    <div class="card" style="margin-bottom:1.5rem;">
      <p style="color:var(--muted); font-size:0.9rem; margin:0 0 0.5rem;">
        Issue Let's Encrypt certificates for hostnames <strong>not</strong> hosted by Beachhead — e.g. a NAS behind the
        same public IP. Because this machine owns ports 80/443 and runs the ACME client, it validates and auto-renews
        these certs for you; download the files and install them on the other device.
      </p>
      <p style="color:var(--muted); font-size:0.82rem; margin:0;">
        The hostname must resolve to this machine's public IP (so the HTTP-01 challenge reaches it), and ports 80/443
        must be reachable from the internet.
      </p>
    </div>

    <!-- Add cert -->
    <div class="card" style="margin-bottom:1.5rem;">
      <h3 style="margin-bottom:0.75rem;">Add certificate</h3>
      <div style="display:flex; gap:0.75rem; align-items:flex-end; flex-wrap:wrap;">
        <div style="flex:1; min-width:160px;">
          <label style="font-size:0.78rem; color:var(--muted);">Label (optional)</label>
          <input v-model="form.name" placeholder="e.g. Synology NAS" style="width:100%;" />
        </div>
        <div style="flex:2; min-width:240px;">
          <label style="font-size:0.78rem; color:var(--muted);">Domain(s)</label>
          <input v-model="form.domains" placeholder="nas.example.com, media.example.com" style="width:100%;" />
          <p style="color:var(--muted); font-size:0.72rem; margin:0.3rem 0 0;">
            One certificate covering one or more hostnames. Comma or space separated.
          </p>
        </div>
        <button class="btn" @click="addCert" :disabled="adding || !form.domains.trim()">
          {{ adding ? 'Adding…' : 'Add' }}
        </button>
      </div>
      <p v-if="addError" style="color:var(--danger); font-size:0.82rem; margin:0.6rem 0 0;">{{ addError }}</p>
    </div>

    <div v-if="loading" style="color:var(--muted);">Loading…</div>
    <div v-else-if="certs.length === 0" class="card" style="color:var(--muted); font-size:0.9rem;">
      No standalone certificates yet.
    </div>

    <div v-for="cert in certs" :key="cert.id" class="card" style="margin-bottom:1rem;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap;">
        <div style="flex:1; min-width:240px;">
          <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
            <strong v-if="cert.name">{{ cert.name }}</strong>
            <span v-if="cert.status.issued" class="badge badge-success" style="font-size:0.65rem;">Issued</span>
            <span v-else class="badge badge-warning" style="font-size:0.65rem;">Pending issuance</span>
            <span v-if="cert.status.issued && cert.status.days_remaining !== null"
                  :class="['badge', cert.status.days_remaining < 15 ? 'badge-warning' : '']"
                  style="font-size:0.65rem;">
              {{ cert.status.days_remaining }}d left
            </span>
          </div>
          <div style="margin-top:0.5rem; display:flex; gap:0.35rem; flex-wrap:wrap;">
            <code v-for="d in cert.domains" :key="d" style="font-size:0.8rem; background:var(--surface); padding:0.15rem 0.45rem; border-radius:4px;">{{ d }}</code>
          </div>
          <p v-if="cert.status.issued && cert.status.expires_at" style="color:var(--muted); font-size:0.76rem; margin:0.5rem 0 0;">
            Expires {{ formatDate(cert.status.expires_at) }} · auto-renews
          </p>
          <p v-else style="color:var(--muted); font-size:0.76rem; margin:0.5rem 0 0;">
            Waiting for Let's Encrypt to issue — usually under a minute. Use Refresh if it lingers.
          </p>
        </div>

        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
          <button class="btn btn-sm" :disabled="!cert.status.issued || busy === cert.id" @click="download(cert, 'fullchain')">
            ↓ Full chain
          </button>
          <button class="btn btn-sm" :disabled="!cert.status.issued || busy === cert.id" @click="download(cert, 'key')">
            ↓ Private key
          </button>
          <button class="btn btn-sm" :disabled="busy === cert.id" @click="refresh(cert)" title="Trigger an issue/renew check now">
            {{ busy === cert.id ? '…' : 'Refresh' }}
          </button>
          <button class="btn btn-danger btn-sm" :disabled="busy === cert.id" @click="remove(cert)">×</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    certs: [],
    loading: true,
    adding: false,
    addError: null,
    busy: null,
    form: { name: '', domains: '' },
    notice: null,
    diag: null,
    diagLoading: false,
  }),
  async mounted() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        this.certs = await api.getCerts();
      } catch (e) {
        this.addError = e.message;
      } finally {
        this.loading = false;
      }
    },
    async addCert() {
      this.addError = null;
      this.notice = null;
      this.adding = true;
      try {
        const res = await api.createCert({ name: this.form.name.trim() || null, domains: this.form.domains });
        this.form = { name: '', domains: '' };
        if (res && res.warning) this.notice = res.warning;
        await this.load();
      } catch (e) {
        this.addError = e.message;
      } finally {
        this.adding = false;
      }
    },
    async runDiagnostics() {
      this.diagLoading = true;
      try {
        this.diag = await api.getCertDiagnostics();
      } catch (e) {
        this.diag = { reachable: false, container: 'acme-companion', content: '', error: e.message };
      } finally {
        this.diagLoading = false;
      }
    },
    async download(cert, type) {
      this.busy = cert.id;
      try {
        await api.downloadCert(cert.id, type);
      } catch (e) {
        alert('Download failed: ' + e.message);
      } finally {
        this.busy = null;
      }
    },
    async refresh(cert) {
      this.busy = cert.id;
      this.notice = null;
      try {
        const res = await api.refreshCert(cert.id);
        if (res && res.sync && !res.sync.pushed) this.notice = res.message;
        // Give acme a moment, then reload status.
        setTimeout(() => this.load(), 1500);
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        this.busy = null;
      }
    },
    async remove(cert) {
      if (!confirm(`Remove certificate for ${cert.domains.join(', ')}?\n\nThis stops Beachhead renewing it. Already-installed copies keep working until they expire.`)) return;
      this.busy = cert.id;
      try {
        await api.deleteCert(cert.id);
        await this.load();
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        this.busy = null;
      }
    },
    formatDate(iso) {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } catch {
        return iso;
      }
    },
  },
};
</script>
