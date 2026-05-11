<template>
  <div v-if="loading" style="color: var(--muted);">Loading...</div>
  <div v-else-if="error" style="color: var(--danger);">{{ error }}</div>
  <div v-else>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
      <h2>
        {{ site.name }}
        <span class="badge badge-info" style="margin-left:0.5rem; font-size:0.7rem;">
          {{ site.source_type === 'git' ? 'static · git' : 'static · upload' }}
        </span>
      </h2>
      <div>
        <button v-if="site.source_type === 'git'"
                class="btn"
                @click="deployFromGit"
                :disabled="deploying"
                style="margin-right:0.5rem;">
          {{ deploying ? 'Deploying...' : 'Deploy from Git' }}
        </button>
        <button v-else class="btn" @click="restart" :disabled="deploying" style="margin-right:0.5rem;">
          {{ deploying ? 'Starting...' : 'Restart Container' }}
        </button>
        <button class="btn btn-danger" @click="deleteSite">Delete</button>
      </div>
    </div>

    <HomeNetworkBanner context="static site" :domain="site.domain" />

    <!-- Details ────────────────────────────────────────────────────── -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Details</h3>
      <table style="width:100%; font-size:0.875rem;">
        <tr><td style="color: var(--muted); width:170px;">Domain</td><td>{{ site.domain }}</td></tr>
        <tr><td style="color: var(--muted);">Created</td><td>{{ new Date(site.created_at).toLocaleString() }}</td></tr>
        <tr><td style="color: var(--muted);">Last Updated</td><td>{{ new Date(site.updated_at).toLocaleString() }}</td></tr>
        <tr>
          <td style="color: var(--muted);">WWW Redirect</td>
          <td>
            <span v-if="site.www_redirect" class="badge badge-success" style="margin-right:0.5rem;">Enabled</span>
            <span v-else style="color:var(--muted); margin-right:0.5rem;">—</span>
            <button v-if="!site.www_redirect" class="btn btn-sm" @click="enableWww" :disabled="wwwApplying">
              {{ wwwApplying ? 'Applying…' : 'Enable WWW' }}
            </button>
          </td>
        </tr>
      </table>
    </div>

    <!-- Git config ──────────────────────────────────────────────────── -->
    <div v-if="site.source_type === 'git'" class="card">
      <h3 style="margin-bottom:0.75rem;">Git source</h3>
      <table style="width:100%; font-size:0.875rem;">
        <tr><td style="color: var(--muted); width:170px;">Repository</td><td><code>{{ site.repo_url }}</code></td></tr>
        <tr><td style="color: var(--muted);">Branch</td><td><code>{{ site.branch }}</code></td></tr>
        <tr><td style="color: var(--muted);">Sub-path</td><td><code>{{ site.subpath }}</code></td></tr>
        <tr v-if="site.build_command">
          <td style="color: var(--muted);">Build command</td>
          <td><code>{{ site.build_command }}</code></td>
        </tr>
        <tr v-if="site.build_command">
          <td style="color: var(--muted);">Build image</td>
          <td><code>{{ site.build_image }}</code></td>
        </tr>
        <tr>
          <td style="color: var(--muted);">Auto-deploy on push</td>
          <td>
            <span v-if="site.auto_deploy" class="badge badge-success">on</span>
            <span v-else class="badge">off</span>
          </td>
        </tr>
        <tr v-if="site.last_deploy_state">
          <td style="color: var(--muted);">Last deploy</td>
          <td>
            <span :class="['badge', stateBadgeClass]">{{ site.last_deploy_state }}</span>
            <span v-if="site.last_deploy_at" style="color:var(--muted); margin-left:0.5rem;">
              {{ new Date(site.last_deploy_at).toLocaleString() }}
            </span>
            <span v-if="site.last_commit_hash" style="color:var(--muted); margin-left:0.5rem;">
              · <code>{{ site.last_commit_hash.slice(0, 7) }}</code>
            </span>
          </td>
        </tr>
      </table>
      <div v-if="logs" style="margin-top:0.75rem;">
        <details>
          <summary style="cursor:pointer; font-size:0.85rem; color:var(--muted);">Show last deploy log</summary>
          <pre style="margin-top:0.5rem; padding:0.75rem; background:var(--bg-2); font-size:0.75rem; max-height:400px; overflow:auto;">{{ logs }}</pre>
        </details>
      </div>
    </div>

    <!-- Webhook hint for git sites ──────────────────────────────────── -->
    <div v-if="site.source_type === 'git'" class="card" style="font-size:0.85rem; color:var(--muted);">
      To enable auto-deploy, point a GitHub webhook at
      <code>https://&lt;BEACHHEAD_DOMAIN&gt;/api/webhooks/github</code> with
      content type <code>application/json</code>, the <em>push</em> event, and
      the secret you configured here (or the global <code>GITHUB_WEBHOOK_SECRET</code>).
    </div>

    <!-- Upload UI (upload-mode sites only) ─────────────────────────── -->
    <div v-if="site.source_type !== 'git'" class="card">
      <h3 style="margin-bottom:0.75rem;">Upload Files</h3>
      <p style="color:var(--muted); font-size:0.85rem; margin-bottom:0.75rem;">
        Upload an <code>index.html</code> file or a <code>.zip</code> archive containing your site files.
        Uploading replaces all existing files and restarts the container.
      </p>
      <div style="display:flex; gap:0.75rem; align-items:center;">
        <input type="file" ref="fileInput" accept=".html,.htm,.zip" @change="onFileSelect" />
        <button class="btn" @click="uploadFile" :disabled="!selectedFile || uploading">
          {{ uploading ? 'Uploading...' : 'Upload & Deploy' }}
        </button>
      </div>
      <div v-if="uploadMessage" style="margin-top:0.75rem; color:var(--success); font-size:0.85rem;">{{ uploadMessage }}</div>
      <div v-if="uploadError" style="margin-top:0.75rem; color:var(--danger); font-size:0.85rem;">{{ uploadError }}</div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';
import HomeNetworkBanner from '../components/HomeNetworkBanner.vue';

export default {
  components: { HomeNetworkBanner },
  data: () => ({
    site: null,
    loading: true,
    error: null,
    deploying: false,
    wwwApplying: false,
    selectedFile: null,
    uploading: false,
    uploadMessage: null,
    uploadError: null,
    logs: '',
  }),
  computed: {
    stateBadgeClass() {
      const s = this.site?.last_deploy_state;
      if (s === 'SUCCESS') return 'badge-success';
      if (s === 'FAILED') return 'badge-danger';
      return 'badge-info';
    },
  },
  async created() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        this.site = await api.getStaticSite(this.$route.params.id);
        if (this.site.source_type === 'git') {
          try {
            const r = await api.getStaticSiteLogs(this.site.id);
            this.logs = r.log || '';
          } catch { /* logs are best-effort */ }
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    onFileSelect(e) {
      this.selectedFile = e.target.files[0] || null;
      this.uploadMessage = null;
      this.uploadError = null;
    },
    async uploadFile() {
      if (!this.selectedFile) return;
      this.uploading = true;
      this.uploadMessage = null;
      this.uploadError = null;
      try {
        const result = await api.uploadStaticSite(this.site.id, this.selectedFile);
        this.uploadMessage = result.message;
        this.selectedFile = null;
        if (this.$refs.fileInput) this.$refs.fileInput.value = '';
        await this.load();
      } catch (e) {
        this.uploadError = e.message;
      } finally {
        this.uploading = false;
      }
    },
    async restart() {
      this.deploying = true;
      try {
        await api.deployStaticSite(this.site.id);
        alert('Container restarted');
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        this.deploying = false;
      }
    },
    async deployFromGit() {
      this.deploying = true;
      try {
        const result = await api.deployStaticSiteFromGit(this.site.id);
        alert(`${result.message}${result.commit ? ` (commit ${result.commit.slice(0, 7)})` : ''}`);
        await this.load();
      } catch (e) {
        // The error message from the server may include the failure log path —
        // just show the message; logs are visible via the disclosure below.
        alert('Deploy failed: ' + e.message);
        await this.load();
      } finally {
        this.deploying = false;
      }
    },
    async enableWww() {
      if (!confirm(`Enable WWW redirect for ${this.site.domain}?\n\nThis will:\n• Request a certificate for www.${this.site.domain}\n• Configure a 301 redirect from www to the root domain\n• Restart the container`)) return;
      this.wwwApplying = true;
      try {
        const result = await api.enableStaticSiteWww(this.site.id);
        alert(result.message);
        await this.load();
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        this.wwwApplying = false;
      }
    },
    async deleteSite() {
      if (!confirm(`Delete ${this.site.name}? This cannot be undone.`)) return;
      try {
        await api.deleteStaticSite(this.site.id);
        this.$router.push('/static-sites');
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    },
  },
};
</script>
