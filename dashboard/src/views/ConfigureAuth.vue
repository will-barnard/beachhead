<template>
  <div>
    <h2 style="margin-bottom: 0.5rem;">Configure Authentication</h2>
    <p style="color: var(--muted); margin-bottom: 1.5rem;">
      Set up <strong>brew-auth</strong> to secure your Beachhead instance. This will create the auth app, configure it, and trigger an initial deploy.
    </p>

    <div v-if="error" style="color: var(--danger); margin-bottom: 1rem;">{{ error }}</div>
    <div v-if="success" class="card" style="border-color: var(--success);">
      <p style="color: var(--success); font-weight: 600; margin-bottom: 0.5rem;">Auth configured successfully!</p>
      <p style="color: var(--muted);">brew-auth is deploying. Once it's live, Beachhead will require authentication.</p>
      <router-link :to="`/apps/${appId}`" class="btn" style="margin-top: 1rem;">View brew-auth</router-link>
    </div>

    <form v-else @submit.prevent="submit" class="card">
      <div class="form-group">
        <label>brew-auth Repository URL</label>
        <input v-model="form.auth_repo_url" required placeholder="https://github.com/you/brew-auth" />
      </div>
      <div class="form-group">
        <label>Auth Domain</label>
        <input v-model="form.auth_domain" required placeholder="auth.example.com" />
        <small style="color: var(--muted);">The subdomain where brew-auth will be served</small>
      </div>
      <div class="form-group">
        <label>Auth Cookie Domain</label>
        <input v-model="form.auth_cookie_domain" required placeholder=".example.com" />
        <small style="color: var(--muted);">Leading dot shares cookies across subdomains</small>
      </div>

      <hr style="border-color: var(--border); margin: 1.5rem 0;" />
      <h3 style="margin-bottom: 1rem; font-size: 1rem;">Admin Account</h3>

      <div class="form-group">
        <label>Super Admin Email</label>
        <input v-model="form.super_admin_email" type="email" required placeholder="admin@example.com" />
      </div>
      <div class="form-group">
        <label>Super Admin Password</label>
        <input v-model="form.super_admin_password" type="password" required placeholder="Strong passphrase" />
      </div>

      <hr style="border-color: var(--border); margin: 1.5rem 0;" />
      <h3 style="margin-bottom: 1rem; font-size: 1rem;">Database</h3>

      <div class="form-group">
        <label>Database Password</label>
        <div style="display: flex; gap: 0.5rem;">
          <input v-model="form.db_password" required placeholder="Generated automatically" />
          <button type="button" class="btn btn-sm" @click="generatePassword" style="white-space: nowrap;">Generate</button>
        </div>
      </div>

      <hr style="border-color: var(--border); margin: 1.5rem 0;" />
      <h3 style="margin-bottom: 1rem; font-size: 1rem;">Email (Resend)</h3>

      <div class="form-group">
        <label>Resend API Key</label>
        <input v-model="form.resend_api_key" required placeholder="re_xxxxx" />
      </div>
      <div class="form-group">
        <label>Resend From Email</label>
        <input v-model="form.resend_from_email" required placeholder="Brew Auth <noreply@example.com>" />
      </div>

      <button class="btn" type="submit" :disabled="submitting" style="margin-top: 0.5rem;">
        {{ submitting ? 'Configuring...' : 'Configure Auth & Deploy' }}
      </button>
    </form>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    form: {
      auth_repo_url: '',
      auth_domain: '',
      auth_cookie_domain: '',
      db_password: '',
      super_admin_email: '',
      super_admin_password: '',
      resend_api_key: '',
      resend_from_email: '',
    },
    error: null,
    success: false,
    appId: null,
    submitting: false,
  }),
  mounted() {
    this.generatePassword();
  },
  methods: {
    generatePassword() {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      this.form.db_password = Array.from(arr, b => chars[b % chars.length]).join('');
    },
    async submit() {
      this.submitting = true;
      this.error = null;
      try {
        const result = await api.configureAuth(this.form);
        this.success = true;
        this.appId = result.app_id;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  },
};
</script>
