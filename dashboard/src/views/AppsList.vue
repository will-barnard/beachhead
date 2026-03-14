<template>
  <div>
    <h2 style="margin-bottom: 1.5rem;">Applications</h2>
    <div v-if="loading" style="color: var(--muted);">Loading...</div>
    <div v-else-if="error" style="color: var(--danger);">{{ error }}</div>
    <div v-else-if="apps.length === 0" class="card" style="text-align:center; color: var(--muted);">
      No apps registered yet. <router-link to="/apps/new">Create one</router-link>.
    </div>
    <div v-else>
      <div v-for="app in apps" :key="app.id" class="card" style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <router-link :to="`/apps/${app.id}`" style="font-weight:600; font-size:1.1rem;">{{ app.name }}</router-link>
          <div style="color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem;">
            {{ app.domain }} · {{ app.branch }}
            <span v-if="app.system_app" class="badge badge-warning" style="margin-left:0.5rem;">system</span>
          </div>
        </div>
        <button class="btn btn-sm" @click="deploy(app.id)">Deploy</button>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({ apps: [], loading: true, error: null }),
  async created() {
    try {
      this.apps = await api.getApps();
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  },
  methods: {
    async deploy(id) {
      try {
        await api.deploy(id);
        alert('Deployment triggered');
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
  },
};
</script>
