<template>
  <div>
    <h2 style="margin-bottom:1.5rem;">Register New App</h2>
    <div v-if="error" style="color:var(--danger); margin-bottom:1rem;">{{ error }}</div>
    <form @submit.prevent="submit" class="card">
      <div class="form-group">
        <label>Name</label>
        <input v-model="form.name" required placeholder="my-app" />
      </div>
      <div class="form-group">
        <label>Repository URL</label>
        <input v-model="form.repo_url" required placeholder="https://github.com/user/repo" />
      </div>
      <div class="form-group">
        <label>Domain</label>
        <input v-model="form.domain" required placeholder="app.example.com" />
      </div>
      <div class="form-group">
        <label>Branch</label>
        <input v-model="form.branch" placeholder="main" />
      </div>
      <div class="form-group">
        <label>Public Service (container name in docker-compose)</label>
        <input v-model="form.public_service" placeholder="web" />
      </div>
      <div class="form-group">
        <label>Public Port (internal port)</label>
        <input v-model.number="form.public_port" type="number" placeholder="3000" />
      </div>
      <div class="form-group">
        <label>Webhook Secret</label>
        <input v-model="form.webhook_secret" placeholder="optional" />
      </div>
      <div class="form-group">
        <label><input type="checkbox" v-model="form.auto_deploy" style="width:auto; margin-right:0.5rem;" /> Auto-deploy on push</label>
      </div>
      <div class="form-group">
        <label><input type="checkbox" v-model="form.stop_previous" style="width:auto; margin-right:0.5rem;" /> Stop previous containers after successful deploy</label>
      </div>
      <button class="btn" type="submit" :disabled="submitting">
        {{ submitting ? 'Creating...' : 'Create App' }}
      </button>
    </form>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    form: {
      name: '',
      repo_url: '',
      domain: '',
      branch: 'main',
      public_service: '',
      public_port: null,
      webhook_secret: '',
      auto_deploy: true,
      stop_previous: true,
    },
    error: null,
    submitting: false,
  }),
  methods: {
    async submit() {
      this.submitting = true;
      this.error = null;
      try {
        const app = await api.createApp(this.form);
        this.$router.push(`/apps/${app.id}`);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  },
};
</script>
