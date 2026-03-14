<template>
  <div v-if="loading" style="color: var(--muted);">Loading...</div>
  <div v-else-if="error" style="color: var(--danger);">{{ error }}</div>
  <div v-else>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
      <h2>{{ app.name }}</h2>
      <div>
        <button class="btn" @click="triggerDeploy" style="margin-right:0.5rem;">Deploy Now</button>
        <button class="btn btn-danger" @click="deleteApp">Delete</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Details</h3>
      <table style="width:100%; font-size:0.875rem;">
        <tr><td style="color: var(--muted); width:150px;">Domain</td><td>{{ app.domain }}</td></tr>
        <tr><td style="color: var(--muted);">Repository</td><td>{{ app.repo_url }}</td></tr>
        <tr><td style="color: var(--muted);">Branch</td><td>{{ app.branch }}</td></tr>
        <tr><td style="color: var(--muted);">Public Service</td><td>{{ app.public_service || '—' }}</td></tr>
        <tr><td style="color: var(--muted);">Public Port</td><td>{{ app.public_port || '—' }}</td></tr>
        <tr><td style="color: var(--muted);">Auto-Deploy</td><td>{{ app.auto_deploy ? 'Yes' : 'No' }}</td></tr>
        <tr><td style="color: var(--muted);">System App</td><td>{{ app.system_app ? 'Yes' : 'No' }}</td></tr>
      </table>
    </div>

    <!-- Environment Variables -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Environment Variables</h3>
      <div v-if="envVars.length === 0" style="color:var(--muted); font-size:0.85rem;">No variables set.</div>
      <div v-for="ev in envVars" :key="ev.id" style="display:flex; justify-content:space-between; align-items:center; padding:0.375rem 0; border-bottom:1px solid var(--border);">
        <code style="font-size:0.8rem;">{{ ev.key }}={{ ev.value }}<span v-if="ev.target_service" style="color:var(--muted);"> ({{ ev.target_service }})</span></code>
        <button class="btn btn-danger btn-sm" @click="removeEnv(ev.id)">×</button>
      </div>
      <div style="display:flex; gap:0.5rem; margin-top:0.75rem;">
        <input v-model="newEnv.key" placeholder="KEY" style="flex:1;" />
        <input v-model="newEnv.value" placeholder="value" style="flex:2;" />
        <input v-model="newEnv.target_service" placeholder="service (optional)" style="flex:1;" />
        <button class="btn btn-sm" @click="addEnv">Add</button>
      </div>
    </div>

    <!-- Deployments -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Deployments</h3>
      <div v-if="deployments.length === 0" style="color:var(--muted); font-size:0.85rem;">No deployments yet.</div>
      <div v-for="d in deployments" :key="d.id" class="card" style="margin-bottom:0.5rem; padding:0.75rem;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>#{{ d.id }}</strong>
            <span style="color:var(--muted); font-size:0.8rem; margin-left:0.5rem;">
              {{ d.commit_hash ? d.commit_hash.slice(0, 8) : 'manual' }}
            </span>
          </div>
          <span :class="stateClass(d.state)" class="badge">{{ d.state }}</span>
        </div>
        <div style="color:var(--muted); font-size:0.8rem; margin-top:0.25rem;">
          {{ new Date(d.created_at).toLocaleString() }}
        </div>
        <pre v-if="selectedDeploy === d.id && d.logs" style="margin-top:0.5rem;">{{ d.logs }}</pre>
        <button v-if="d.logs" class="btn btn-sm" style="margin-top:0.5rem;" @click="selectedDeploy = selectedDeploy === d.id ? null : d.id">
          {{ selectedDeploy === d.id ? 'Hide Logs' : 'Show Logs' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    app: null,
    deployments: [],
    envVars: [],
    loading: true,
    error: null,
    selectedDeploy: null,
    newEnv: { key: '', value: '', target_service: '' },
  }),
  async created() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        const id = this.$route.params.id;
        const [app, deployments, envVars] = await Promise.all([
          api.getApp(id),
          api.getDeployments(id),
          api.getEnvVars(id),
        ]);
        this.app = app;
        this.deployments = deployments;
        this.envVars = envVars;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    stateClass(state) {
      if (state === 'SUCCESS') return 'badge-success';
      if (state === 'FAILED') return 'badge-danger';
      if (state === 'PENDING') return 'badge-warning';
      return 'badge-info';
    },
    async triggerDeploy() {
      try {
        await api.deploy(this.app.id);
        await this.load();
      } catch (e) {
        alert('Deploy failed: ' + e.message);
      }
    },
    async deleteApp() {
      if (!confirm(`Delete ${this.app.name}? This cannot be undone.`)) return;
      try {
        await api.deleteApp(this.app.id);
        this.$router.push('/');
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    },
    async addEnv() {
      if (!this.newEnv.key) return;
      try {
        await api.setEnvVar(this.app.id, this.newEnv);
        this.newEnv = { key: '', value: '', target_service: '' };
        this.envVars = await api.getEnvVars(this.app.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
    async removeEnv(envId) {
      try {
        await api.deleteEnvVar(this.app.id, envId);
        this.envVars = await api.getEnvVars(this.app.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
  },
};
</script>
