<template>
  <div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
      <h2>Static Sites</h2>
      <router-link to="/static-sites/new" class="btn">+ New Static Site</router-link>
    </div>
    <div v-if="loading" style="color: var(--muted);">Loading...</div>
    <div v-else-if="error" style="color: var(--danger);">{{ error }}</div>
    <div v-else-if="sites.length === 0" class="card" style="text-align:center; color: var(--muted);">
      No static sites yet. <router-link to="/static-sites/new">Create one</router-link>.
    </div>
    <div v-else>
      <div v-for="site in sites" :key="site.id" class="card" style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <router-link :to="`/static-sites/${site.id}`" style="font-weight:600; font-size:1.1rem;">{{ site.name }}</router-link>
          <div style="color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem;">
            {{ site.domain }}
            <span class="badge badge-info" style="margin-left:0.5rem;">static</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({ sites: [], loading: true, error: null }),
  async created() {
    try {
      this.sites = await api.getStaticSites();
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  },
};
</script>
