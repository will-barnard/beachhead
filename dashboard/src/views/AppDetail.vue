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
        <tr>
          <td style="color: var(--muted);">WWW Redirect</td>
          <td>
            <span v-if="app.www_redirect" class="badge badge-success" style="margin-right:0.5rem;">Enabled</span>
            <span v-else style="color:var(--muted); margin-right:0.5rem;">—</span>
            <button v-if="!app.www_redirect" class="btn btn-sm" @click="enableWww" :disabled="wwwApplying"
                    :title="'Request cert and configure redirect for www.' + app.domain">
              {{ wwwApplying ? 'Applying…' : 'Enable WWW' }}
            </button>
          </td>
        </tr>
      </table>
    </div>

    <!-- Additional Endpoints -->
    <div class="card">
      <h3 style="margin-bottom:0.75rem;">Additional Endpoints</h3>
      <p style="color:var(--muted); font-size:0.8rem; margin-bottom:0.75rem;">
        Map additional docker-compose services to their own subdomains. Each endpoint gets its own SSL certificate.
      </p>
      <div v-if="endpoints.length === 0 && !addingEndpoint" style="color:var(--muted); font-size:0.85rem;">No additional endpoints configured.</div>
      <div v-for="ep in endpoints" :key="ep.id" style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem 0; border-bottom:1px solid var(--border);">
        <div>
          <code style="font-size:0.85rem;">{{ ep.service }}</code>
          <span style="color:var(--muted); margin:0 0.5rem;">→</span>
          <span style="font-size:0.85rem;">{{ ep.domain }}:{{ ep.port }}</span>
          <span v-if="ep.www_redirect" class="badge badge-success" style="margin-left:0.5rem; font-size:0.65rem;">www</span>
        </div>
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <button v-if="!ep.www_redirect" class="btn btn-sm" @click="enableEndpointWww(ep)"
                  :disabled="ep._wwwApplying" :title="'Enable www.' + ep.domain">
            {{ ep._wwwApplying ? '…' : 'WWW' }}
          </button>
          <button class="btn btn-danger btn-sm" @click="removeEndpoint(ep)">×</button>
        </div>
      </div>
      <div v-if="addingEndpoint" style="display:flex; gap:0.5rem; margin-top:0.75rem; align-items:flex-end;">
        <div style="flex:1;">
          <label style="font-size:0.75rem; color:var(--muted);">Service</label>
          <input v-model="newEndpoint.service" placeholder="admin" />
        </div>
        <div style="flex:2;">
          <label style="font-size:0.75rem; color:var(--muted);">Domain</label>
          <input v-model="newEndpoint.domain" placeholder="admin.example.com" />
        </div>
        <div style="flex:0.5;">
          <label style="font-size:0.75rem; color:var(--muted);">Port</label>
          <input v-model.number="newEndpoint.port" type="number" placeholder="80" />
        </div>
        <button class="btn btn-sm" @click="addEndpoint">Add</button>
        <button class="btn btn-sm" @click="addingEndpoint = false">Cancel</button>
      </div>
      <button v-if="!addingEndpoint" class="btn btn-sm" style="margin-top:0.75rem;" @click="addingEndpoint = true">+ Add Endpoint</button>
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
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
        <h3>Deployments</h3>
        <button class="btn btn-sm" @click="pruneDeployments" :disabled="pruning">{{ pruning ? 'Pruning…' : 'Prune Old Deploys' }}</button>
      </div>
      <div v-if="deployments.length === 0" style="color:var(--muted); font-size:0.85rem;">No deployments yet.</div>
      <div v-for="(d, index) in deployments" :key="d.id" class="card" style="margin-bottom:0.5rem; padding:0.75rem;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>#{{ d.id }}</strong>
            <span style="color:var(--muted); font-size:0.8rem; margin-left:0.5rem;">
              {{ d.commit_hash ? d.commit_hash.slice(0, 8) : 'manual' }}
            </span>
            <span v-if="isActiveDeployment(d, index)" class="badge badge-success" style="margin-left:0.5rem; font-size:0.65rem;">Active</span>
          </div>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <button
              v-if="d.state === 'SUCCESS' && !isActiveDeployment(d, index)"
              class="btn btn-sm"
              @click="rollback(d)"
              :disabled="rollingBack === d.id"
            >
              {{ rollingBack === d.id ? 'Rolling back…' : 'Rollback' }}
            </button>
            <span :class="stateClass(d.state)" class="badge">{{ d.state }}</span>
          </div>
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
    endpoints: [],
    loading: true,
    error: null,
    selectedDeploy: null,
    newEnv: { key: '', value: '', target_service: '' },
    addingFile: false,
    newFile: { path: '', content: '' },
    editingFile: null,
    editFileContent: '',
    wwwApplying: false,
    addingEndpoint: false,
    newEndpoint: { service: '', domain: '', port: 80 },
    rollingBack: null,
    pruning: false,
  }),
  async created() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        const id = this.$route.params.id;
        const [app, deployments, envVars, envFiles, endpoints] = await Promise.all([
          api.getApp(id),
          api.getDeployments(id),
          api.getEnvVars(id),
          api.getEnvFiles(id),
          api.getEndpoints(id),
        ]);
        this.app = app;
        this.deployments = deployments;
        this.envVars = envVars;
        this.envFiles = envFiles;
        this.endpoints = endpoints;
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
    async enableWww() {
      if (!confirm(`Enable WWW redirect for ${this.app.domain}?\n\nThis will:\n• Request a certificate for www.${this.app.domain}\n• Configure a 301 redirect from www to the root domain\n• Restart the running container to apply changes`)) return;
      this.wwwApplying = true;
      try {
        const result = await api.enableWwwRedirect(this.app.id);
        alert(result.message);
        await this.load();
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        this.wwwApplying = false;
      }
    },
    async addEndpoint() {
      if (!this.newEndpoint.service || !this.newEndpoint.domain) return;
      try {
        await api.addEndpoint(this.app.id, this.newEndpoint);
        this.newEndpoint = { service: '', domain: '', port: 80 };
        this.addingEndpoint = false;
        this.endpoints = await api.getEndpoints(this.app.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
    async removeEndpoint(ep) {
      if (!confirm(`Remove endpoint ${ep.service} → ${ep.domain}?`)) return;
      try {
        await api.deleteEndpoint(this.app.id, ep.id);
        this.endpoints = await api.getEndpoints(this.app.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
    async enableEndpointWww(ep) {
      if (!confirm(`Enable WWW redirect for ${ep.domain}?`)) return;
      ep._wwwApplying = true;
      try {
        const result = await api.enableEndpointWww(this.app.id, ep.id);
        alert(result.message);
        this.endpoints = await api.getEndpoints(this.app.id);
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        ep._wwwApplying = false;
      }
    },
    isActiveDeployment(deployment, index) {
      if (this.app.active_deployment_id != null) {
        return deployment.id === this.app.active_deployment_id;
      }
      // Fall back to most recent SUCCESS when active_deployment_id not yet tracked
      return index === 0 && deployment.state === 'SUCCESS';
    },
    async pruneDeployments() {
      const input = prompt('How many recent successful deploys to keep?', '3');
      if (input === null) return;
      const keep = parseInt(input, 10);
      if (isNaN(keep) || keep < 1) { alert('Must keep at least 1.'); return; }
      this.pruning = true;
      try {
        const result = await api.pruneApp(this.app.id, keep);
        alert(`Pruned ${result.prunedCount} deployment(s).`);
        await this.load();
      } catch (e) {
        alert('Prune failed: ' + e.message);
      } finally {
        this.pruning = false;
      }
    },
    async rollback(dep) {
      if (!confirm(`Roll back to deployment #${dep.id} (${dep.commit_hash ? dep.commit_hash.slice(0, 8) : 'manual'})?

This will stop the current containers and restart this deployment's images.`)) return;
      this.rollingBack = dep.id;
      try {
        const result = await api.rollbackDeployment(this.app.id, dep.id);
        alert(result.message);
        await this.load();
      } catch (e) {
        alert('Rollback failed: ' + e.message);
      } finally {
        this.rollingBack = null;
      }
    },
  },
};
</script>
