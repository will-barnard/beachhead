<template>
  <div id="app">
    <header>
      <nav>
        <router-link to="/" class="logo">⚓ Beachhead</router-link>
        <div style="display: flex; gap: 0.5rem;">
          <router-link v-if="bootstrapMode" to="/bootstrap" class="btn btn-warning">⚙ Configure Auth</router-link>
          <router-link to="/system" class="btn">📦 System</router-link>
          <router-link to="/static-sites" class="btn">📄 Static Sites</router-link>
          <router-link to="/apps/new" class="btn">+ New App</router-link>
        </div>
      </nav>
    </header>
    <main>
      <router-view />
    </main>
  </div>
</template>

<script>
import api from './api.js';

export default {
  data: () => ({
    bootstrapMode: false,
  }),
  async mounted() {
    try {
      const health = await api.getHealth();
      this.bootstrapMode = health.mode === 'bootstrap';
    } catch {
      // ignore — health check failure shouldn't block the UI
    }
  },
};
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --bg: #0f1117;
  --surface: #1a1d27;
  --border: #2a2d3a;
  --text: #e1e4ed;
  --muted: #8b8fa3;
  --accent: #4f8ff7;
  --success: #34d399;
  --danger: #f87171;
  --warning: #fbbf24;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}

header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0.75rem 1.5rem;
}

nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 1200px;
  margin: 0 auto;
}

.logo {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text);
  text-decoration: none;
}

main {
  max-width: 1200px;
  margin: 2rem auto;
  padding: 0 1.5rem;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.btn {
  display: inline-block;
  padding: 0.5rem 1rem;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  text-decoration: none;
}
.btn:hover { opacity: 0.9; text-decoration: none; }
.btn-danger { background: var(--danger); }
.btn-warning { background: var(--warning); color: #000; }
.btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}

.badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
}
.badge-success { background: rgba(52,211,153,0.15); color: var(--success); }
.badge-danger { background: rgba(248,113,113,0.15); color: var(--danger); }
.badge-warning { background: rgba(251,191,36,0.15); color: var(--warning); }
.badge-info { background: rgba(79,143,247,0.15); color: var(--accent); }

input, select, textarea {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  font-size: 0.875rem;
  width: 100%;
}

label {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 0.875rem;
  color: var(--muted);
}

.form-group { margin-bottom: 1rem; }

pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1rem;
  overflow-x: auto;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
