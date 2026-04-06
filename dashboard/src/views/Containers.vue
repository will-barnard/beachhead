<template>
  <div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
      <h2>Containers &amp; System</h2>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn" @click="loadContainers" :disabled="loading">{{ loading ? 'Loading…' : 'Refresh' }}</button>
        <button class="btn btn-warning" @click="systemPrune" :disabled="pruning">{{ pruning ? 'Pruning…' : 'Prune All Apps' }}</button>
      </div>
    </div>

    <!-- Summary -->
    <div class="card" style="margin-bottom:1rem;">
      <div style="display:flex; gap:2rem; font-size:0.85rem;">
        <div><strong>{{ containers.length }}</strong> <span style="color:var(--muted)">total</span></div>
        <div><span style="color:var(--success)">{{ running }}</span> <span style="color:var(--muted)">running</span></div>
        <div><span style="color:var(--danger)">{{ stopped }}</span> <span style="color:var(--muted)">stopped/exited</span></div>
        <div><span style="color:var(--warning)">{{ unknownOwner }}</span> <span style="color:var(--muted)">unrecognized</span></div>
      </div>
    </div>

    <div v-if="error" style="color:var(--danger); margin-bottom:1rem;">{{ error }}</div>

    <!-- Grouped containers -->
    <div v-for="group in groupedContainers" :key="group.label" class="card" style="margin-bottom:1rem;">
      <h3 style="margin-bottom:0.75rem; font-size:0.95rem;">
        {{ group.label }}
        <span class="badge" :class="ownerBadgeClass(group.owner)" style="margin-left:0.5rem; font-size:0.65rem;">{{ group.containers.length }}</span>
      </h3>
      <div style="overflow-x:auto;">
        <table style="width:100%; font-size:0.8rem; border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:1px solid var(--border); color:var(--muted);">
              <th style="text-align:left; padding:0.375rem 0.5rem;">Name</th>
              <th style="text-align:left; padding:0.375rem 0.5rem;">Image</th>
              <th style="text-align:left; padding:0.375rem 0.5rem;">Status</th>
              <th style="text-align:left; padding:0.375rem 0.5rem;">Project</th>
              <th style="text-align:right; padding:0.375rem 0.5rem;">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in group.containers" :key="c.id" style="border-bottom:1px solid var(--border);">
              <td style="padding:0.375rem 0.5rem;">
                <code style="font-size:0.78rem;">{{ c.name }}</code>
              </td>
              <td style="padding:0.375rem 0.5rem; color:var(--muted);">{{ truncImage(c.image) }}</td>
              <td style="padding:0.375rem 0.5rem;">
                <span :class="stateClass(c.state)" class="badge" style="font-size:0.65rem;">{{ c.state }}</span>
                <span style="color:var(--muted); font-size:0.72rem; margin-left:0.25rem;">{{ c.status }}</span>
              </td>
              <td style="padding:0.375rem 0.5rem; color:var(--muted); font-size:0.78rem;">{{ c.project || '—' }}</td>
              <td style="padding:0.375rem 0.5rem; text-align:right;">
                <button v-if="c.state === 'running'" class="btn btn-warning btn-sm" @click="stopContainer(c)" style="margin-right:0.25rem;">Stop</button>
                <button class="btn btn-danger btn-sm" @click="removeContainer(c)">Remove</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="!loading && containers.length === 0" style="color:var(--muted);">No containers found.</div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    containers: [],
    loading: true,
    error: null,
    pruning: false,
  }),
  computed: {
    running() { return this.containers.filter(c => c.state === 'running').length; },
    stopped() { return this.containers.filter(c => c.state !== 'running').length; },
    unknownOwner() { return this.containers.filter(c => c.owner === 'unknown').length; },
    groupedContainers() {
      const groups = {};
      for (const c of this.containers) {
        const key = c.owner === 'app-deploy' ? (c.project || c.ownerDetail || 'deploy') :
                    c.owner === 'stateful' ? (c.ownerDetail || 'stateful') :
                    c.owner;
        if (!groups[key]) {
          groups[key] = { owner: c.owner, label: this.groupLabel(c), containers: [] };
        }
        groups[key].containers.push(c);
      }
      // Sort: beachhead first, then apps, then static, then unknown
      const order = { beachhead: 0, stateful: 1, 'app-deploy': 2, 'static-site': 3, unknown: 4 };
      return Object.values(groups).sort((a, b) => (order[a.owner] ?? 5) - (order[b.owner] ?? 5));
    },
  },
  async created() {
    await this.loadContainers();
  },
  methods: {
    async loadContainers() {
      this.loading = true;
      this.error = null;
      try {
        this.containers = await api.getContainers();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    groupLabel(c) {
      if (c.owner === 'beachhead') return 'Beachhead Infrastructure';
      if (c.owner === 'stateful') return `Stateful: ${c.ownerDetail || 'unknown'}`;
      if (c.owner === 'app-deploy') return `Deploy: ${c.project || c.ownerDetail || 'unknown'}`;
      if (c.owner === 'static-site') return `Static Site: ${c.ownerDetail || 'unknown'}`;
      return 'Unrecognized';
    },
    ownerBadgeClass(owner) {
      if (owner === 'beachhead') return 'badge-info';
      if (owner === 'app-deploy' || owner === 'stateful') return 'badge-success';
      if (owner === 'static-site') return 'badge-success';
      return 'badge-warning';
    },
    stateClass(state) {
      if (state === 'running') return 'badge-success';
      if (state === 'exited' || state === 'dead') return 'badge-danger';
      return 'badge-warning';
    },
    truncImage(img) {
      if (!img) return '—';
      // Strip sha256 prefix for readability
      return img.length > 40 ? img.slice(0, 37) + '…' : img;
    },
    async stopContainer(c) {
      if (!confirm(`Stop container "${c.name}"?`)) return;
      try {
        await api.stopContainer(c.id);
        await this.loadContainers();
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
    async removeContainer(c) {
      if (!confirm(`Remove container "${c.name}"? This will force-remove it.`)) return;
      try {
        await api.removeContainer(c.id);
        await this.loadContainers();
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    },
    async systemPrune() {
      const keep = prompt('How many successful deployments to keep per app?', '3');
      if (keep === null) return;
      this.pruning = true;
      try {
        const result = await api.systemPrune(parseInt(keep, 10) || 3);
        alert(`Pruned ${result.totalPruned} deployment(s) across ${result.details.length} app(s)`);
        await this.loadContainers();
      } catch (e) {
        alert('Prune failed: ' + e.message);
      } finally {
        this.pruning = false;
      }
    },
  },
};
</script>
