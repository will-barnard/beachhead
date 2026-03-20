<template>
  <div v-if="loading" style="color: var(--muted);">Loading...</div>
  <div v-else-if="error" style="color: var(--danger);">{{ error }}</div>
  <div v-else>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
      <h2>{{ app.name }}</h2>
      <div>
        <button class="btn" @click="triggerDeploy" style="margin-right:0.5rem;">Deploy Now</button>
        <button class="btn btn-warning" @click="cancelDeployment" style="margin-right:0.5rem;">Cancel Stuck Deploy</button>
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
        <tr><td style="color: var(--muted);">Stop Previous</td><td>{{ app.stop_previous !== false ? 'Yes' : 'No' }}</td></tr>
        <tr><td style="color: var(--muted);">System App</td><td>{{ app.system_app ? 'Yes' : 'No' }}</td></tr>
      </table>
    </div>

    <!-- Env Files -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Env Files</h3>
      <p style="color:var(--muted); font-size:0.8rem; margin-bottom:0.75rem;">
        Define .env files to write to specific paths in your repo at deploy time. Paste the full file contents — Beachhead parses and stores the values.
      </p>

      <!-- Existing files -->
      <div v-for="ef in envFiles" :key="ef.id" class="card" style="margin-bottom:0.75rem; padding:0.75rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <code style="font-size:0.85rem; color:var(--accent);">{{ ef.path }}</code>
          <div style="display:flex; gap:0.5rem;">
            <button class="btn btn-sm" @click="toggleEditFile(ef)">{{ editingFile === ef.id ? 'Cancel' : 'Edit' }}</button>
            <button class="btn btn-danger btn-sm" @click="removeEnvFile(ef.id)">Delete</button>
          </div>
        </div>
        <div style="font-size:0.78rem; color:var(--muted);">
          {{ ef.vars.length }} var{{ ef.vars.length !== 1 ? 's' : '' }}:
          <span v-for="(v, i) in ef.vars" :key="v.id">{{ v.key }}<span v-if="i < ef.vars.length - 1">, </span></span>
        </div>
        <div v-if="editingFile === ef.id" style="margin-top:0.75rem;">
          <textarea v-model="editFileContent" rows="10" style="width:100%; font-family:monospace; font-size:0.8rem;" placeholder="KEY=value&#10;ANOTHER_KEY=value"></textarea>
          <button class="btn btn-sm" style="margin-top:0.5rem;" @click="saveEnvFile(ef.path, ef.id)">Save</button>
        </div>
      </div>

      <!-- Add new file form -->
      <div v-if="addingFile" class="card" style="margin-bottom:0.75rem; padding:0.75rem; border:1px dashed var(--border);">
        <div style="margin-bottom:0.5rem;">
          <input v-model="newFile.path" placeholder="relative/path/.env" style="width:100%;" />
        </div>
        <textarea v-model="newFile.content" rows="10" style="width:100%; font-family:monospace; font-size:0.8rem;" placeholder="KEY=value&#10;ANOTHER_KEY=value&#10;# comments are ignored"></textarea>
        <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
          <button class="btn btn-sm" @click="saveNewEnvFile">Save</button>
          <button class="btn btn-sm" @click="addingFile = false">Cancel</button>
        </div>
      </div>

      <button class="btn btn-sm" @click="addingFile = true" v-if="!addingFile" style="margin-top:0.25rem;">+ Add Env File</button>
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
    envFiles: [],
    loading: true,
    error: null,
    selectedDeploy: null,
    newEnv: { key: '', value: '', target_service: '' },
    addingFile: false,
    newFile: { path: '', content: '' },
    editingFile: null,
    editFileContent: '',
  }),
  async created() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        const id = this.$route.params.id;
        const [app, deployments, envVars, envFiles] = await Promise.all([
          api.getApp(id),
          api.getDeployments(id),
          api.getEnvVars(id),
          api.getEnvFiles(id),
        ]);
        this.app = app;
        this.deployments = deployments;
        this.envVars = envVars;
        this.envFiles = envFiles;
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
    async cancelDeployment() {
      try {
        const { cancelled } = await api.cancelDeployment(this.app.id);
        if (cancelled === 0) {
          alert('No active deployments to cancel.');
        } else {
          await this.load();
        }
      } catch (e) {
        alert('Cancel failed: ' + e.message);
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
    toggleEditFile(ef) {
      if (this.editingFile === ef.id) {
        this.editingFile = null;
        this.editFileContent = '';
      } else {
        this.editingFile = ef.id;
        this.editFileContent = ef.vars.map((v) => `${v.key}=${v.value}`).join('\n');
      }
    },
    async saveEnvFile(filePath, fileId) {
      try {
        await api.saveEnvFile(this.app.id, { path: filePath, content: this.editFileContent });
        this.editingFile = null;
        this.editFileContent = '';
        this.envFiles = await api.getEnvFiles(this.app.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
    async saveNewEnvFile() {
      if (!this.newFile.path) return;
      try {
        await api.saveEnvFile(this.app.id, { path: this.newFile.path, content: this.newFile.content });
        this.newFile = { path: '', content: '' };
        this.addingFile = false;
        this.envFiles = await api.getEnvFiles(this.app.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
    async removeEnvFile(fileId) {
      if (!confirm('Delete this env file and all its values?')) return;
      try {
        await api.deleteEnvFile(this.app.id, fileId);
        this.envFiles = await api.getEnvFiles(this.app.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
  },
};
</script>
