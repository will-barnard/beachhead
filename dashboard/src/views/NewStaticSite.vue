<template>
  <div>
    <h2 style="margin-bottom:1.5rem;">New Static Site</h2>
    <HomeNetworkBanner context="static site" :domain="form.domain" />
    <div v-if="error" style="color:var(--danger); margin-bottom:1rem;">{{ error }}</div>
    <form @submit.prevent="submit" class="card">
      <div class="form-group">
        <label>Source</label>
        <div style="display:flex; gap:1rem; align-items:center;">
          <label style="font-weight:normal;">
            <input type="radio" value="upload" v-model="form.source_type" /> Upload files
          </label>
          <label style="font-weight:normal;">
            <input type="radio" value="git" v-model="form.source_type" /> Deploy from Git
          </label>
        </div>
      </div>

      <div class="form-group">
        <label>Name</label>
        <input v-model="form.name" required placeholder="my-website" />
      </div>
      <div class="form-group">
        <label>Domain</label>
        <input v-model="form.domain" required placeholder="www.example.com" />
      </div>

      <!-- Git-only fields ────────────────────────────────────────────── -->
      <template v-if="form.source_type === 'git'">
        <div class="form-group">
          <label>Repository URL</label>
          <input v-model="form.repo_url" required
                 placeholder="https://github.com/user/repo or git@github.com:user/repo" />
        </div>
        <div class="form-group">
          <label>Branch</label>
          <input v-model="form.branch" placeholder="main" />
        </div>
        <div class="form-group">
          <label>Sub-path to serve</label>
          <input v-model="form.subpath" placeholder=". (repo root) or dist or build" />
          <small style="color:var(--muted);">
            Directory inside the repo (or build output) whose contents become the site root.
            Leave as <code>.</code> to serve the repo root.
          </small>
        </div>
        <div class="form-group">
          <label>Build command (optional)</label>
          <input v-model="form.build_command"
                 placeholder="npm ci && npm run build" />
          <small style="color:var(--muted);">
            Runs inside <code>{{ form.build_image || 'node:20-alpine' }}</code> with the repo
            mounted at <code>/workspace</code>. Leave blank for pure static repos.
          </small>
        </div>
        <div class="form-group">
          <label>Build image</label>
          <input v-model="form.build_image" placeholder="node:20-alpine" />
        </div>
        <div class="form-group">
          <label>Webhook secret (optional)</label>
          <input v-model="form.webhook_secret" placeholder="leave blank to use the global secret" />
        </div>
        <div class="form-group">
          <label style="font-weight:normal;">
            <input type="checkbox" v-model="form.auto_deploy" />
            Auto-deploy on GitHub push to <code>{{ form.branch || 'main' }}</code>
          </label>
        </div>
      </template>

      <button class="btn" type="submit" :disabled="submitting">
        {{ submitting ? 'Creating...' : 'Create Static Site' }}
      </button>
    </form>
  </div>
</template>

<script>
import api from '../api.js';
import HomeNetworkBanner from '../components/HomeNetworkBanner.vue';

export default {
  components: { HomeNetworkBanner },
  data: () => ({
    form: {
      source_type: 'upload',
      name: '',
      domain: '',
      repo_url: '',
      branch: 'main',
      subpath: '.',
      build_command: '',
      build_image: 'node:20-alpine',
      webhook_secret: '',
      auto_deploy: true,
    },
    error: null,
    submitting: false,
  }),
  methods: {
    async submit() {
      this.submitting = true;
      this.error = null;
      try {
        // Strip git-only fields if user chose upload mode so the API gets a
        // clean payload and the row doesn't pick up stray defaults.
        const payload = { name: this.form.name, domain: this.form.domain, source_type: this.form.source_type };
        if (this.form.source_type === 'git') {
          Object.assign(payload, {
            repo_url: this.form.repo_url,
            branch: this.form.branch || 'main',
            subpath: this.form.subpath || '.',
            build_command: this.form.build_command || null,
            build_image: this.form.build_image || 'node:20-alpine',
            webhook_secret: this.form.webhook_secret || null,
            auto_deploy: !!this.form.auto_deploy,
          });
        }
        const site = await api.createStaticSite(payload);
        this.$router.push(`/static-sites/${site.id}`);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  },
};
</script>
