<template>
  <div>
    <h2 style="margin-bottom: 0.5rem;">Configure Authentication</h2>
    <p style="color: var(--muted); margin-bottom: 1.5rem;">
      Set up <strong>brew-auth</strong> to secure your Beachhead instance.
    </p>

    <div v-if="error" style="color: var(--danger); margin-bottom: 1rem;">{{ error }}</div>

    <!-- Step: Already configured, waiting for deploy / activation -->
    <div v-if="status && status.step === 'awaiting-activation'" class="card">
      <h3 style="margin-bottom: 1rem;">brew-auth is configured</h3>

      <div v-if="status.mode === 'remote'">
        <p style="color: var(--muted); margin-bottom: 0.75rem;">
          Connected to remote brew-auth at <strong>{{ status.auth_url }}</strong>
        </p>
        <p style="color: var(--muted); margin-bottom: 1rem;">
          Workspace: <strong>{{ status.workspace_slug }}</strong>
        </p>
      </div>
      <div v-else>
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
      </div>

      <div style="display: flex; gap: 0.75rem; align-items: center;">
        <button class="btn" @click="activate" :disabled="activating">
          {{ activating ? 'Activating...' : 'Activate Auth' }}
        </button>
        <router-link v-if="status.app_id" :to="`/apps/${status.app_id}`">View brew-auth app</router-link>
      </div>
      <p v-if="activateError" style="color: var(--danger); margin-top: 0.75rem;">{{ activateError }}</p>
    </div>

    <!-- Step: Auth is active -->
    <div v-else-if="status && status.step === 'active'" class="card" style="border-color: var(--success);">
      <p style="color: var(--success); font-weight: 600;">Auth is active.</p>
      <p v-if="status.mode === 'remote'" style="color: var(--muted); margin-top: 0.5rem;">
        Connected to remote brew-auth at <strong>{{ status.auth_url }}</strong>
        (workspace: <strong>{{ status.workspace_slug }}</strong>)
      </p>
      <p v-else style="color: var(--muted); margin-top: 0.5rem;">
        Beachhead is secured via local brew-auth at <strong>{{ status.domain }}</strong>.
      </p>
    </div>

    <!-- Step: Configure — pick mode -->
    <div v-else-if="!status || status.step === 'not-configured'">
      <div v-if="configured" class="card" style="border-color: var(--success);">
        <p style="color: var(--success); font-weight: 600; margin-bottom: 0.5rem;">
          {{ configuredMode === 'remote' ? 'Connected to remote brew-auth!' : 'brew-auth created and deploying!' }}
        </p>
        <p style="color: var(--muted); margin-bottom: 1rem;">
          {{ configuredMode === 'remote' ? 'Activate auth to start requiring authentication.' : 'Once the deploy completes, come back here to activate auth.' }}
        </p>
        <div style="display: flex; gap: 0.75rem; align-items: center;">
          <router-link v-if="configuredAppId" :to="`/apps/${configuredAppId}`" class="btn">View brew-auth</router-link>
          <a href="#" @click.prevent="refreshStatus">Check status</a>
        </div>
      </div>

      <!-- Mode picker -->
      <div v-else>
        <div style="display: flex; gap: 1rem; margin-bottom: 1.5rem;">
          <button class="btn" :class="{ 'btn-active': mode === 'local' }" @click="mode = 'local'"
                  style="flex: 1; padding: 1rem;">
            <strong>Deploy brew-auth locally</strong><br>
            <small style="color: var(--muted);">Run brew-auth on this VM</small>
          </button>
          <button class="btn" :class="{ 'btn-active': mode === 'remote' }" @click="mode = 'remote'"
                  style="flex: 1; padding: 1rem;">
            <strong>Connect to existing brew-auth</strong><br>
            <small style="color: var(--muted);">Use a brew-auth on another VM</small>
          </button>
        </div>

        <!-- Local mode form -->
        <form v-if="mode === 'local'" @submit.prevent="submitLocal" class="card">
          <div class="form-group">
            <label>brew-auth Repository URL</label>
            <input v-model="localForm.auth_repo_url" required placeholder="https://github.com/you/brew-auth" />
          </div>
          <div class="form-group">
            <label>Auth Domain</label>
            <input v-model="localForm.auth_domain" required placeholder="auth.example.com" />
            <small style="color: var(--muted);">The subdomain where brew-auth will be served</small>
          </div>
          <div class="form-group">
            <label>Auth Cookie Domain</label>
            <input v-model="localForm.auth_cookie_domain" required placeholder=".example.com" />
            <small style="color: var(--muted);">Leading dot shares cookies across subdomains</small>
          </div>

          <hr style="border-color: var(--border); margin: 1.5rem 0;" />
          <h3 style="margin-bottom: 1rem; font-size: 1rem;">Admin Account</h3>

          <div class="form-group">
            <label>Super Admin Email</label>
            <input v-model="localForm.super_admin_email" type="email" required placeholder="admin@example.com" />
          </div>
          <div class="form-group">
            <label>Super Admin Password</label>
            <input v-model="localForm.super_admin_password" type="password" required placeholder="Strong passphrase" />
          </div>

          <hr style="border-color: var(--border); margin: 1.5rem 0;" />
          <h3 style="margin-bottom: 1rem; font-size: 1rem;">Database</h3>

          <div class="form-group">
            <label>Database Password</label>
            <div style="display: flex; gap: 0.5rem;">
              <input v-model="localForm.db_password" required placeholder="Generated automatically" />
              <button type="button" class="btn btn-sm" @click="generatePassword" style="white-space: nowrap;">Generate</button>
            </div>
          </div>

          <hr style="border-color: var(--border); margin: 1.5rem 0;" />
          <h3 style="margin-bottom: 1rem; font-size: 1rem;">Email (Resend)</h3>

          <div class="form-group">
            <label>Resend API Key</label>
            <input v-model="localForm.resend_api_key" required placeholder="re_xxxxx" />
          </div>
          <div class="form-group">
            <label>Resend From Email</label>
            <input v-model="localForm.resend_from_email" required placeholder="Brew Auth <noreply@example.com>" />
          </div>

          <button class="btn" type="submit" :disabled="submitting" style="margin-top: 0.5rem;">
            {{ submitting ? 'Configuring...' : 'Configure Auth & Deploy' }}
          </button>
        </form>

        <!-- Remote mode form -->
        <form v-if="mode === 'remote'" @submit.prevent="submitRemote" class="card">
          <div class="form-group">
            <label>brew-auth URL</label>
            <input v-model="remoteForm.auth_url" required placeholder="https://auth.example.com" />
            <small style="color: var(--muted);">The URL of the existing brew-auth instance</small>
          </div>

          <hr style="border-color: var(--border); margin: 1.5rem 0;" />
          <h3 style="margin-bottom: 1rem; font-size: 1rem;">Workspace</h3>

          <div class="form-group">
            <label>Workspace Name</label>
            <input v-model="remoteForm.workspace_name" required placeholder="My Server" />
          </div>
          <div class="form-group">
            <label>Workspace Slug</label>
            <input v-model="remoteForm.workspace_slug" required placeholder="my-server"
                   pattern="[a-z0-9\-]+" title="Lowercase letters, numbers, and hyphens only" />
            <small style="color: var(--muted);">Unique identifier for this Beachhead instance</small>
          </div>

          <hr style="border-color: var(--border); margin: 1.5rem 0;" />
          <h3 style="margin-bottom: 1rem; font-size: 1rem;">brew-auth Super Admin Credentials</h3>

          <div class="form-group">
            <label>Admin Email</label>
            <input v-model="remoteForm.admin_email" type="email" required placeholder="admin@example.com" />
          </div>
          <div class="form-group">
            <label>Admin Password</label>
            <input v-model="remoteForm.admin_password" type="password" required />
          </div>

          <button class="btn" type="submit" :disabled="submitting" style="margin-top: 0.5rem;">
            {{ submitting ? 'Connecting...' : 'Connect to brew-auth' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    mode: null,
    localForm: {
      auth_repo_url: '',
      auth_domain: '',
      auth_cookie_domain: '',
      db_password: '',
      super_admin_email: '',
      super_admin_password: '',
      resend_api_key: '',
      resend_from_email: '',
    },
    remoteForm: {
      auth_url: '',
      workspace_name: '',
      workspace_slug: '',
      admin_email: '',
      admin_password: '',
    },
    error: null,
    status: null,
    configured: false,
    configuredMode: null,
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
      this.localForm.db_password = Array.from(arr, b => chars[b % chars.length]).join('');
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
    async submitLocal() {
      this.submitting = true;
      this.error = null;
      try {
        const result = await api.configureAuth(this.localForm);
        this.configured = true;
        this.configuredMode = 'local';
        this.configuredAppId = result.app_id;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
    async submitRemote() {
      this.submitting = true;
      this.error = null;
      try {
        await api.connectAuth(this.remoteForm);
        this.configured = true;
        this.configuredMode = 'remote';
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
