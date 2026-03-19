<template>
  <div>
    <h2 style="margin-bottom: 0.5rem;">Configure Authentication</h2>
    <p style="color: var(--muted); margin-bottom: 1.5rem;">
      Set up <strong>brew-auth</strong> to secure your Beachhead instance.
    </p>

    <div v-if="error" style="color: var(--danger); margin-bottom: 1rem;">{{ error }}</div>

    <!-- Step 1: Already configured, waiting for deploy / activation -->
    <div v-if="status && status.step === 'awaiting-activation'" class="card">
      <h3 style="margin-bottom: 1rem;">brew-auth is configured</h3>
      <p style="color: var(--muted); margin-bottom: 0.75rem;">
        Domain: <strong>{{ status.domain }}</strong>
      </p>
      <p v-if="status.last_deploy" style="margin-bottom: 1rem;">
        Latest deploy:
        <span :class="deployBadgeClass(status.last_deploy.state)" class="badge">
          {{ status.last_deploy.state }}
        </span>
      </p>
      <p v-if="status.last_deploy && status.last_deploy.state !== 'SUCCESS'" style="color: var(--muted); margin-bottom: 1rem;">
        Waiting for brew-auth to deploy successfully before activating auth.
        <a href="#" @click.prevent="refreshStatus" style="margin-left: 0.5rem;">Refresh</a>
      </p>
      <div style="display: flex; gap: 0.75rem; align-items: center;">
        <button class="btn" @click="activate" :disabled="activating">
          {{ activating ? 'Activating...' : 'Activate Auth' }}
        </button>
        <router-link :to="`/apps/${status.app_id}`">View brew-auth app</router-link>
      </div>
      <p v-if="activateError" style="color: var(--danger); margin-top: 0.75rem;">{{ activateError }}</p>
    </div>

    <!-- Step 2: Auth is active -->
    <div v-else-if="status && status.step === 'active'" class="card" style="border-color: var(--success);">
      <p style="color: var(--success); font-weight: 600;">Auth is active.</p>
      <p style="color: var(--muted); margin-top: 0.5rem;">Beachhead is secured via brew-auth at <strong>{{ status.domain }}</strong>.</p>
    </div>

    <!-- Step 0: Configure form -->
    <div v-else-if="!status || status.step === 'not-configured'">
      <div v-if="configured" class="card" style="border-color: var(--success);">
        <p style="color: var(--success); font-weight: 600; margin-bottom: 0.5rem;">brew-auth created and deploying!</p>
        <p style="color: var(--muted); margin-bottom: 1rem;">
          Once the deploy completes, come back here to activate auth.
        </p>
        <div style="display: flex; gap: 0.75rem; align-items: center;">
          <router-link :to="`/apps/${configuredAppId}`" class="btn">View brew-auth</router-link>
          <a href="#" @click.prevent="refreshStatus">Check status</a>
        </div>
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
    status: null,
    configured: false,
    configuredAppId: null,
    submitting: false,
    activating: false,
    activateError: null,
  }),
  async mounted() {
    this.generatePassword();
    await this.refreshStatus();
  },
  methods: {
    generatePassword() {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      this.form.db_password = Array.from(arr, b => chars[b % chars.length]).join('');
    },
    async refreshStatus() {
      try {
        this.status = await api.getBootstrapStatus();
      } catch {
        this.status = null;
      }
    },
    deployBadgeClass(state) {
      if (state === 'SUCCESS') return 'badge-success';
      if (state === 'FAILED') return 'badge-danger';
      return 'badge-warning';
    },
    async submit() {
      this.submitting = true;
      this.error = null;
      try {
        const result = await api.configureAuth(this.form);
        this.configured = true;
        this.configuredAppId = result.app_id;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
    async activate() {
      this.activating = true;
      this.activateError = null;
      try {
        await api.activateAuth();
        await this.refreshStatus();
      } catch (e) {
        this.activateError = e.message;
      } finally {
        this.activating = false;
      }
    },
  },
};
</script>
