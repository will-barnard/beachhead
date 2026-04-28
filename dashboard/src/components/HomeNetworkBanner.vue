<template>
  <div
    v-if="show"
    class="card"
    style="
      margin-bottom: 1rem;
      border-left: 4px solid var(--warning, #d97706);
      background: var(--surface);
    "
  >
    <div style="display: flex; gap: 0.75rem; align-items: flex-start;">
      <div style="font-size: 1.25rem; line-height: 1;">⚠</div>
      <div style="flex: 1;">
        <strong>Home network mode is on.</strong>
        <p style="margin: 0.35rem 0 0.5rem; color: var(--muted); font-size: 0.9rem;">
          For traffic to reach this {{ context }} from the internet:
        </p>
        <ul style="margin: 0; padding-left: 1.25rem; font-size: 0.9rem;">
          <li>Forward <strong>TCP 80</strong> and <strong>TCP 443</strong> on your router to this Beachhead machine.</li>
          <li>
            Point the {{ context }}'s domain
            <span v-if="domain"><code>{{ domain }}</code></span>
            (an <code>A</code> record) at your home's WAN IP — the public IP your router presents to the internet.
          </li>
        </ul>
        <p style="margin: 0.5rem 0 0;">
          <router-link to="/settings" style="font-size: 0.85rem;">Network settings →</router-link>
        </p>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

// Cache the settings fetch across components in a single page session so
// every view that mounts this banner doesn't re-hit /api/bootstrap/settings.
let cachedMode = null;
let inflight = null;

async function fetchMode() {
  if (cachedMode !== null) return cachedMode;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const settings = await api.getSettings();
      cachedMode = settings.network_mode || 'direct';
    } catch {
      cachedMode = 'direct';
    } finally {
      inflight = null;
    }
    return cachedMode;
  })();
  return inflight;
}

export default {
  props: {
    // Override the noun used in the message ("app", "static site", etc.)
    context: { type: String, default: 'app' },
    // Optional: the specific domain to highlight in the DNS reminder.
    domain: { type: String, default: '' },
  },
  data: () => ({ mode: 'direct' }),
  computed: {
    show() {
      return this.mode === 'home_network';
    },
  },
  async mounted() {
    this.mode = await fetchMode();
  },
};
</script>
