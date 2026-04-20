<template>
  <div>
    <h2 style="margin-bottom: 1.5rem;">Settings</h2>

    <!-- Users section -->
    <div class="card">
      <h3 style="margin-bottom: 1rem;">Users</h3>

      <table v-if="users.length" style="width: 100%; border-collapse: collapse; margin-bottom: 1.5rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--border); text-align: left;">
            <th style="padding: 0.5rem;">Username</th>
            <th style="padding: 0.5rem;">Role</th>
            <th style="padding: 0.5rem;">Created</th>
            <th style="padding: 0.5rem;"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id" style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.5rem;">{{ u.username }}</td>
            <td style="padding: 0.5rem;"><span class="badge badge-info">{{ u.role }}</span></td>
            <td style="padding: 0.5rem; color: var(--muted);">{{ new Date(u.created_at).toLocaleDateString() }}</td>
            <td style="padding: 0.5rem; text-align: right; white-space: nowrap;">
              <button class="btn btn-sm" @click="generateWorkerToken(u)" style="margin-right: 0.25rem;">Worker Token</button>
              <button v-if="u.id !== currentUserId" class="btn btn-danger btn-sm" @click="removeUser(u)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>

      <h4 style="margin-bottom: 0.75rem;">Add User</h4>
      <div v-if="error" style="color: var(--danger); margin-bottom: 0.75rem;">{{ error }}</div>
      <div v-if="success" style="color: var(--success); margin-bottom: 0.75rem;">{{ success }}</div>

      <div v-if="workerToken" style="margin-bottom: 1rem; padding: 0.75rem; background: var(--surface); border: 1px solid var(--border); border-radius: 4px;">
        <strong>Worker token for {{ workerTokenUser }}</strong> (expires in 1 year)
        <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; align-items: center;">
          <input :value="workerToken" readonly style="flex: 1; font-family: monospace; font-size: 0.8rem;" @click="$event.target.select()" />
          <button class="btn btn-sm" @click="copyToken">{{ copied ? 'Copied!' : 'Copy' }}</button>
        </div>
        <p style="color: var(--muted); font-size: 0.8rem; margin: 0.5rem 0 0 0;">This token won't be shown again. Copy it now.</p>
      </div>

      <form @submit.prevent="addUser" style="display: flex; gap: 0.5rem; align-items: flex-end; flex-wrap: wrap;">
        <div>
          <label>Username</label>
          <input v-model="newUsername" required style="width: 200px;" />
        </div>
        <div>
          <label>Password</label>
          <input v-model="newPassword" type="password" required minlength="8" style="width: 200px;" autocomplete="new-password" />
        </div>
        <button class="btn" type="submit" :disabled="adding">{{ adding ? 'Adding...' : 'Add' }}</button>
      </form>
    </div>

    <!-- Logout -->
    <div style="margin-top: 2rem;">
      <button class="btn btn-danger" @click="logout">Sign Out</button>
    </div>

    <!-- Build Configuration -->
    <div class="card" style="margin-top: 2rem;">
      <h3 style="margin-bottom: 1rem;">Build Configuration</h3>

      <div v-if="buildError" style="color: var(--danger); margin-bottom: 0.75rem;">{{ buildError }}</div>
      <div v-if="buildSuccess" style="color: var(--success); margin-bottom: 0.75rem;">{{ buildSuccess }}</div>

      <div style="margin-bottom: 1rem;">
        <label>Build Mode</label>
        <div style="display: flex; gap: 1rem; margin-top: 0.25rem;">
          <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;">
            <input type="radio" v-model="buildSettings.build_mode" value="local" />
            Server (local builds)
          </label>
          <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;">
            <input type="radio" v-model="buildSettings.build_mode" value="remote" />
            Remote workers
          </label>
        </div>
      </div>

      <div v-if="buildSettings.build_mode === 'remote'" style="margin-bottom: 1rem;">
        <p style="color: var(--muted); margin-bottom: 1rem; font-size: 0.9rem;">
          Remote workers build Docker images and push to a registry.<br/>
          The server then pulls the images during deployment.
        </p>

        <div style="margin-bottom: 1rem;">
          <label>Registry Type</label>
          <div style="display: flex; gap: 1rem; margin-top: 0.25rem;">
            <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;">
              <input type="radio" v-model="buildSettings.registry_type" value="ghcr" />
              GitHub Container Registry (ghcr.io)
            </label>
            <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;">
              <input type="radio" v-model="buildSettings.registry_type" value="generic" />
              Other registry
            </label>
          </div>
        </div>

        <div v-if="buildSettings.registry_type === 'ghcr'" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 400px;">
          <p style="color: var(--muted); font-size: 0.85rem; margin: 0;">
            Images will be pushed to <code>ghcr.io/OWNER/app-service:tag</code>.<br/>
            Create a <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">Personal Access Token</a> with <code>write:packages</code> scope.
          </p>
          <div>
            <label>GitHub Owner / Org</label>
            <input v-model="buildSettings.ghcr_owner" placeholder="e.g. my-github-username" style="width: 100%;" />
          </div>
          <div>
            <label>GitHub PAT</label>
            <input v-model="buildSettings.ghcr_token" type="password" autocomplete="new-password" style="width: 100%;" placeholder="(unchanged if left blank)" />
          </div>
        </div>

        <div v-else style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 400px;">
          <div>
            <label>Registry URL</label>
            <input v-model="buildSettings.registry_url" placeholder="e.g. registry.example.com/myproject" style="width: 100%;" />
          </div>
          <div>
            <label>Registry Username</label>
            <input v-model="buildSettings.registry_user" autocomplete="off" style="width: 100%;" />
          </div>
          <div>
            <label>Registry Password</label>
            <input v-model="buildSettings.registry_password" type="password" autocomplete="new-password" style="width: 100%;" placeholder="(unchanged if left blank)" />
          </div>
        </div>
      </div>

      <div style="margin-top: 1.5rem; max-width: 400px;">
        <label>Git SSH Key Path</label>
        <input v-model="buildSettings.git_ssh_key_path" placeholder="~/.ssh/id_rsa (leave blank to use HTTPS)" style="width: 100%;" />
        <p style="color: var(--muted); font-size: 0.85rem; margin: 0.4rem 0 0;">
          Path to the SSH private key on the server. Used when cloning <code>git@…</code> repos.
          The key must already exist on the server filesystem.
        </p>
      </div>

      <button class="btn" @click="saveBuildSettings" :disabled="savingBuild" style="margin-top: 1.5rem;">
        {{ savingBuild ? 'Saving...' : 'Save Build Settings' }}
      </button>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    users: [],
    currentUserId: null,
    newUsername: '',
    newPassword: '',
    error: null,
    success: null,
    adding: false,
    workerToken: null,
    workerTokenUser: '',
    copied: false,
    buildSettings: {
      build_mode: 'local',
      registry_type: 'ghcr',
      registry_url: '',
      registry_user: '',
      registry_password: '',
      ghcr_owner: '',
      ghcr_token: '',
      git_ssh_key_path: '',
    },
    buildError: null,
    buildSuccess: null,
    savingBuild: false,
  }),
  async mounted() {
    await this.loadUsers();
    await this.loadBuildSettings();
    try {
      const status = await api.getBootstrapStatus();
      if (status.user) this.currentUserId = status.user.id;
    } catch {
      // ignore
    }
  },
  methods: {
    async loadUsers() {
      try {
        this.users = await api.getUsers();
      } catch (e) {
        this.error = e.message;
      }
    },
    async addUser() {
      this.error = null;
      this.success = null;
      this.adding = true;
      try {
        const user = await api.createUser({ username: this.newUsername, password: this.newPassword });
        this.success = `User "${user.username}" created`;
        this.newUsername = '';
        this.newPassword = '';
        await this.loadUsers();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.adding = false;
      }
    },
    async removeUser(u) {
      if (!confirm(`Delete user "${u.username}"?`)) return;
      try {
        await api.deleteUser(u.id);
        await this.loadUsers();
      } catch (e) {
        this.error = e.message;
      }
    },
    async generateWorkerToken(u) {
      this.workerToken = null;
      this.copied = false;
      try {
        const result = await api.generateWorkerToken(u.id);
        this.workerToken = result.token;
        this.workerTokenUser = u.username;
      } catch (e) {
        this.error = e.message;
      }
    },
    async copyToken() {
      try {
        await navigator.clipboard.writeText(this.workerToken);
        this.copied = true;
        setTimeout(() => { this.copied = false; }, 2000);
      } catch {
        // fallback: the input is already selectable
      }
    },
    async logout() {
      try {
        await api.logout();
      } catch {
        // ignore
      }
      this.$router.push('/login');
    },
    async loadBuildSettings() {
      try {
        const settings = await api.getSettings();
        this.buildSettings.build_mode = settings.build_mode || 'local';
        this.buildSettings.registry_type = settings.registry_type || 'ghcr';
        this.buildSettings.registry_url = settings.registry_url || '';
        this.buildSettings.registry_user = settings.registry_user || '';
        this.buildSettings.registry_password = '';  // never display — show placeholder
        this.buildSettings.ghcr_owner = settings.ghcr_owner || '';
        this.buildSettings.ghcr_token = '';  // never display — show placeholder
        this.buildSettings.git_ssh_key_path = settings.git_ssh_key_path || '';
      } catch {
        // settings may not exist yet
      }
    },
    async saveBuildSettings() {
      this.buildError = null;
      this.buildSuccess = null;
      this.savingBuild = true;
      try {
        const payload = { ...this.buildSettings };
        // Don't send empty secrets (means "keep existing")
        if (!payload.registry_password) delete payload.registry_password;
        if (!payload.ghcr_token) delete payload.ghcr_token;
        await api.updateSettings(payload);
        this.buildSuccess = 'Build settings saved';
        this.buildSettings.registry_password = '';
        this.buildSettings.ghcr_token = '';
      } catch (e) {
        this.buildError = e.message;
      } finally {
        this.savingBuild = false;
      }
    },
  },
};
</script>
