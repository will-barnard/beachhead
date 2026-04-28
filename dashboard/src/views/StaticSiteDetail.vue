<template>
  <div v-if="loading" style="color: var(--muted);">Loading...</div>
  <div v-else-if="error" style="color: var(--danger);">{{ error }}</div>
  <div v-else>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
      <h2>
        {{ site.name }}
        <span class="badge badge-info" style="margin-left:0.5rem; font-size:0.7rem;">static</span>
      </h2>
      <div>
        <button class="btn" @click="deploy" :disabled="deploying" style="margin-right:0.5rem;">
          {{ deploying ? 'Starting...' : 'Restart Container' }}
        </button>
        <button class="btn btn-danger" @click="deleteSite">Delete</button>
      </div>
    </div>

    <HomeNetworkBanner context="static site" :domain="site.domain" />

    <!-- Details -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Details</h3>
      <table style="width:100%; font-size:0.875rem;">
        <tr><td style="color: var(--muted); width:150px;">Domain</td><td>{{ site.domain }}</td></tr>
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

    <!-- Upload -->
    <div class="card">
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
  }),
  async created() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        this.site = await api.getStaticSite(this.$route.params.id);
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
    async deploy() {
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
