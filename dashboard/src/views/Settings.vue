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

    <!-- Self-update -->
    <div class="card" style="margin-top: 2rem;">
      <h3 style="margin-bottom: 0.5rem;">Update Beachhead</h3>
      <p style="color: var(--muted); font-size: 0.85rem; margin: 0 0 1rem;">
        Pulls the latest code, rebuilds, and restarts Beachhead itself — the same as SSHing in and running
        <code>./update.sh</code>. This dashboard and every app behind it will be briefly unreachable while it swaps in.
      </p>

      <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.75rem;">
        <span :class="['badge', updateBadgeClass]" style="font-size: 0.7rem;">{{ updateBadgeText }}</span>
        <span v-if="updateStatus && updateStatus.finishedAt && updateStatus.status !== 'running'" style="color: var(--muted); font-size: 0.78rem;">
          {{ new Date(updateStatus.finishedAt).toLocaleString() }}
        </span>
        <button class="btn btn-sm" style="margin-left: auto;" @click="triggerUpdate" :disabled="updateStarting || (updateStatus && updateStatus.status === 'running')">
          {{ updateStarting ? 'Starting…' : (updateStatus && updateStatus.status === 'running' ? 'Updating…' : 'Update Beachhead') }}
        </button>
        <button v-if="updateStatus && updateStatus.status === 'success'" class="btn btn-sm" @click="reloadPage">
          Reload Dashboard
        </button>
      </div>

      <p v-if="updateError" style="color: var(--danger); font-size: 0.82rem; margin: 0 0 0.75rem;">{{ updateError }}</p>

      <pre v-if="updateStatus && updateStatus.log" ref="updateLog"
           style="max-height: 260px; overflow: auto; font-size: 0.75rem;">{{ updateStatus.log }}</pre>
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

      <div style="margin-top: 1.5rem; max-width: 400px;">
        <label>GitHub Personal Access Token (HTTPS)</label>
        <input v-model="buildSettings.git_https_token" type="password" autocomplete="new-password" style="width: 100%;" placeholder="(unchanged if left blank)" />
        <p style="color: var(--muted); font-size: 0.85rem; margin: 0.4rem 0 0;">
          Used to clone private repositories over HTTPS. Create a
          <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">GitHub PAT</a>
          with <code>repo</code> (or <code>contents: read</code>) scope. Leave blank to keep the current token.
        </p>
      </div>

      <button class="btn" @click="saveBuildSettings" :disabled="savingBuild" style="margin-top: 1.5rem;">
        {{ savingBuild ? 'Saving...' : 'Save Build Settings' }}
      </button>
    </div>

    <!-- Network -->
    <div class="card" style="margin-top: 2rem;">
      <h3 style="margin-bottom: 1rem;">Network</h3>

      <div v-if="netError" style="color: var(--danger); margin-bottom: 0.75rem;">{{ netError }}</div>
      <div v-if="netSuccess" style="color: var(--success); margin-bottom: 0.75rem;">{{ netSuccess }}</div>

      <div style="margin-bottom: 1rem;">
        <label>Network Mode</label>
        <div style="display: flex; gap: 1rem; margin-top: 0.25rem;">
          <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;">
            <input type="radio" v-model="networkSettings.network_mode" value="direct" />
            Direct (cloud VM, public IP)
          </label>
          <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;">
            <input type="radio" v-model="networkSettings.network_mode" value="home_network" />
            Home network (behind a router / NAT)
          </label>
        </div>
        <p style="color: var(--muted); font-size: 0.85rem; margin: 0.5rem 0 0;">
          Switch this on if Beachhead is running on a machine behind a home router. The dashboard will then
          surface port-forwarding and DNS reminders on app pages.
        </p>
      </div>

      <div v-if="networkSettings.network_mode === 'home_network' && networkInfo" style="margin-top: 1rem; padding: 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: 4px;">
        <h4 style="margin: 0 0 0.75rem;">Port forwarding</h4>
        <p style="color: var(--muted); font-size: 0.9rem; margin: 0 0 0.75rem;">
          Forward these ports on your router to <strong>this machine</strong>. All apps share these two ports —
          <code>nginx-proxy</code> routes by <code>Host</code> header, so no per-app forwarding is required.
        </p>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 1rem;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border); text-align: left;">
              <th style="padding: 0.4rem;">Port</th>
              <th style="padding: 0.4rem;">Protocol</th>
              <th style="padding: 0.4rem;">Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in networkInfo.requiredPorts" :key="p.port" style="border-bottom: 1px solid var(--border);">
              <td style="padding: 0.4rem;"><strong>{{ p.port }}</strong></td>
              <td style="padding: 0.4rem;">{{ p.protocol.toUpperCase() }}</td>
              <td style="padding: 0.4rem; color: var(--muted);">{{ p.purpose }}</td>
            </tr>
          </tbody>
        </table>

        <h4 style="margin: 1rem 0 0.5rem;">This machine's LAN address</h4>
        <p style="color: var(--muted); font-size: 0.9rem; margin: 0 0 0.5rem;">
          Use this as the forwarding target on your router. (Detected from inside the Beachhead container — pick
          whichever matches your LAN range, typically <code>192.168.x.x</code> or <code>10.x.x.x</code>.)
        </p>
        <ul v-if="networkInfo.lanCandidates.length" style="margin: 0; padding-left: 1.25rem;">
          <li v-for="c in networkInfo.lanCandidates" :key="c.iface + c.address">
            <code>{{ c.address }}</code> <span style="color: var(--muted);">({{ c.iface }})</span>
          </li>
        </ul>
        <p v-else style="color: var(--muted); font-size: 0.9rem; margin: 0.25rem 0 0;">
          No non-loopback IPv4 addresses visible from inside the container. Run <code>ipconfig getifaddr en0</code>
          (Mac) or <code>ip -4 addr</code> (Linux) on the host to find your LAN IP.
        </p>

        <h4 style="margin: 1rem 0 0.5rem;">DNS</h4>
        <p style="color: var(--muted); font-size: 0.9rem; margin: 0;">
          Each app's domain (and the dashboard domain) needs an <strong>A record pointing to your home's WAN IP</strong>
          — the public IP your router presents to the internet. Find it with
          <a href="https://ipv4.icanhazip.com" target="_blank" rel="noopener">icanhazip.com</a>
          or your router's status page. If your ISP gives you a dynamic IP, consider a dynamic-DNS service.
        </p>
      </div>

      <button class="btn" @click="saveNetworkSettings" :disabled="savingNetwork" style="margin-top: 1.5rem;">
        {{ savingNetwork ? 'Saving...' : 'Save Network Settings' }}
      </button>
    </div>

    <!-- Staging -->
    <div class="card" style="margin-top: 2rem;">
      <h3 style="margin-bottom: 1rem;">Staging Domain</h3>

      <div v-if="stagingError" style="color: var(--danger); margin-bottom: 0.75rem;">{{ stagingError }}</div>
      <div v-if="stagingSuccess" style="color: var(--success); margin-bottom: 0.75rem;">{{ stagingSuccess }}</div>

      <p style="color: var(--muted); font-size: 0.9rem; margin: 0 0 0.75rem;">
        Set a wildcard root domain you control (e.g. <code>dev.example.com</code>) so apps can be exposed at
        <code>&lt;subdomain&gt;.dev.example.com</code> alongside their primary domain. Requires a wildcard
        DNS record (<code>*.dev.example.com → this server</code>) so any subdomain resolves automatically.
      </p>

      <div style="max-width: 400px;">
        <label>Staging Root Domain</label>
        <input v-model="stagingSettings.staging_root_domain" placeholder="e.g. dev.example.com" style="width: 100%;" />
        <p style="color: var(--muted); font-size: 0.85rem; margin: 0.4rem 0 0;">
          Leave blank to disable staging URLs. No scheme, no path. Lowercase only.
        </p>
      </div>

      <button class="btn" @click="saveStagingSettings" :disabled="savingStaging" style="margin-top: 1.5rem;">
        {{ savingStaging ? 'Saving...' : 'Save Staging Settings' }}
      </button>
    </div>

    <!-- Under Construction Page -->
    <div class="card" style="margin-top: 2rem;">
      <h3 style="margin-bottom: 1rem;">Under Construction Page</h3>

      <div v-if="constructionError" style="color: var(--danger); margin-bottom: 0.75rem;">{{ constructionError }}</div>
      <div v-if="constructionSuccess" style="color: var(--success); margin-bottom: 0.75rem;">{{ constructionSuccess }}</div>

      <p style="color: var(--muted); font-size: 0.9rem; margin: 0 0 1rem;">
        Default copy for the holding page shown on an app's primary domain while it's in
        staging-only mode — instead of the bare nginx 503. Turn it on per app from the
        app's <strong>Staging URL</strong> card, where you can also override any of these
        fields for that one client.
      </p>

      <div style="max-width: 560px;">
        <label>Heading</label>
        <input
          v-model="constructionSettings.construction_heading"
          placeholder="Coming Soon"
          maxlength="200"
          style="width: 100%;"
        />

        <label style="display: block; margin-top: 1rem;">Message</label>
        <textarea
          v-model="constructionSettings.construction_message"
          placeholder="This site is currently under construction. Please check back soon."
          maxlength="2000"
          rows="4"
          style="width: 100%; font-family: inherit;"
        ></textarea>
        <p style="color: var(--muted); font-size: 0.85rem; margin: 0.4rem 0 0;">
          Plain text — blank lines become separate paragraphs. HTML is escaped, not rendered.
        </p>

        <label style="display: block; margin-top: 1rem;">Contact (optional)</label>
        <input
          v-model="constructionSettings.construction_contact"
          placeholder="hello@example.com"
          maxlength="254"
          style="width: 100%;"
        />
        <p style="color: var(--muted); font-size: 0.85rem; margin: 0.4rem 0 0;">
          An email address or an <code>https://</code> link, shown at the bottom of the page.
          Anything else is rendered as plain text.
        </p>
      </div>

      <button class="btn" @click="saveConstructionSettings" :disabled="savingConstruction" style="margin-top: 1.5rem;">
        {{ savingConstruction ? 'Saving...' : 'Save Page Defaults' }}
      </button>
      <p style="color: var(--muted); font-size: 0.85rem; margin: 0.75rem 0 0;">
        Saving re-renders every live holding page that hasn't overridden these fields.
      </p>
    </div>

    <!-- LAN Ports -->
    <div class="card" style="margin-top: 2rem;">
      <h3 style="margin-bottom: 1rem;">LAN Ports</h3>

      <div v-if="lanError" style="color: var(--danger); margin-bottom: 0.75rem;">{{ lanError }}</div>
      <div v-if="lanSuccess" style="color: var(--success); margin-bottom: 0.75rem;">{{ lanSuccess }}</div>

      <p style="color: var(--muted); font-size: 0.9rem; margin: 0 0 0.75rem;">
        The LAN IPv4 address that static service ports bind to. When set, any app service you expose on a
        fixed port (App → LAN Ports) is bound to this address only, so it stays reachable on your local
        network but not the public internet. Use this machine's LAN IP (e.g. <code>192.168.1.20</code>).
      </p>

      <div style="max-width: 400px;">
        <label>LAN Bind IP</label>
        <input v-model="lanSettings.lan_bind_ip" placeholder="e.g. 192.168.1.20" style="width: 100%;" />
        <p v-if="lanCandidates.length" style="color: var(--muted); font-size: 0.85rem; margin: 0.4rem 0 0;">
          Detected on this host:
          <template v-for="(c, i) in lanCandidates" :key="c.address">
            <a href="#" @click.prevent="lanSettings.lan_bind_ip = c.address" style="text-decoration: underline;">{{ c.address }}</a><span v-if="i < lanCandidates.length - 1">, </span>
          </template>
        </p>
        <p style="color: var(--muted); font-size: 0.85rem; margin: 0.4rem 0 0;">
          Leave blank to disable static ports.
        </p>
      </div>

      <button class="btn" @click="saveLanSettings" :disabled="savingLan" style="margin-top: 1.5rem;">
        {{ savingLan ? 'Saving...' : 'Save LAN Settings' }}
      </button>
    </div>

    <!-- Docker Disk Cleanup -->
    <div class="card" style="margin-top: 2rem;">
      <h3 style="margin-bottom: 1rem;">Docker Disk Cleanup</h3>

      <div v-if="cleanupError" style="color: var(--danger); margin-bottom: 0.75rem;">{{ cleanupError }}</div>
      <div v-if="cleanupSuccess" style="color: var(--success); margin-bottom: 0.75rem;">{{ cleanupSuccess }}</div>

      <p style="color: var(--muted); font-size: 0.9rem; margin: 0 0 0.75rem;">
        Runs <code>docker system prune -a</code> on this VM, removing all stopped containers,
        unused images (including old build layers), unused networks, and build cache.
        Running containers and their images are not affected.
      </p>

      <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; margin-bottom: 1rem;">
        <input type="checkbox" v-model="cleanupIncludeVolumes" />
        Also remove unused Docker volumes (<code>--volumes</code>)
      </label>

      <button class="btn btn-danger" @click="runDockerCleanup" :disabled="runningCleanup">
        {{ runningCleanup ? 'Cleaning...' : 'Run Docker Cleanup' }}
      </button>

      <div v-if="cleanupSummary" style="margin-top: 1.25rem;">
        <p style="margin: 0 0 0.75rem; font-size: 0.9rem;">
          <strong>Cleanup complete</strong>
          <span v-if="cleanupSummary.totalReclaimed" style="color: var(--success); margin-left: 0.5rem; font-weight: 600;">— {{ cleanupSummary.totalReclaimed }} reclaimed</span>
          <span v-else style="color: var(--muted); margin-left: 0.5rem;">— nothing to reclaim</span>
        </p>
        <div v-if="cleanupSummary.before || cleanupSummary.after" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div v-if="cleanupSummary.before">
            <div style="color: var(--muted); font-size: 0.75rem; margin-bottom: 0.25rem;">Before</div>
            <pre style="margin: 0; font-size: 0.75rem;">{{ cleanupSummary.before }}</pre>
          </div>
          <div v-if="cleanupSummary.after">
            <div style="color: var(--muted); font-size: 0.75rem; margin-bottom: 0.25rem;">After</div>
            <pre style="margin: 0; font-size: 0.75rem;">{{ cleanupSummary.after }}</pre>
          </div>
        </div>
      </div>
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
      git_https_token: '',
    },
    buildError: null,
    buildSuccess: null,
    savingBuild: false,
    networkSettings: {
      network_mode: 'direct',
    },
    networkInfo: null,
    netError: null,
    netSuccess: null,
    savingNetwork: false,
    stagingSettings: {
      staging_root_domain: '',
    },
    stagingError: null,
    stagingSuccess: null,
    savingStaging: false,
    constructionSettings: {
      construction_heading: '',
      construction_message: '',
      construction_contact: '',
    },
    constructionError: null,
    constructionSuccess: null,
    savingConstruction: false,
    lanSettings: {
      lan_bind_ip: '',
    },
    lanCandidates: [],
    lanError: null,
    lanSuccess: null,
    savingLan: false,
    cleanupIncludeVolumes: false,
    runningCleanup: false,
    cleanupError: null,
    cleanupSuccess: null,
    cleanupSummary: null,
    updateStatus: null,
    updateStarting: false,
    updateError: null,
    updatePolling: false,
    updatePollTimer: null,
  }),
  async mounted() {
    await this.loadUsers();
    await this.loadBuildSettings();
    await this.loadNetworkSettings();
    await this.loadStagingSettings();
    await this.loadConstructionSettings();
    await this.loadLanSettings();
    await this.loadUpdateStatus();
    try {
      const status = await api.getBootstrapStatus();
      if (status.user) this.currentUserId = status.user.id;
    } catch {
      // ignore
    }
  },
  beforeUnmount() {
    clearTimeout(this.updatePollTimer);
  },
  computed: {
    updateBadgeClass() {
      const s = this.updateStatus && this.updateStatus.status;
      if (s === 'running') return 'badge-info';
      if (s === 'success') return 'badge-success';
      if (s === 'failed') return 'badge-danger';
      return 'badge-warning';
    },
    updateBadgeText() {
      const s = this.updateStatus && this.updateStatus.status;
      if (s === 'running') return 'Updating…';
      if (s === 'success') return 'Up to date';
      if (s === 'failed') return `Failed (exit ${this.updateStatus.exitCode})`;
      return 'Not run yet';
    },
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
        this.buildSettings.git_https_token = '';  // never display — show placeholder
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
        if (!payload.git_https_token) delete payload.git_https_token;
        await api.updateSettings(payload);
        this.buildSuccess = 'Build settings saved';
        this.buildSettings.registry_password = '';
        this.buildSettings.ghcr_token = '';
        this.buildSettings.git_https_token = '';
      } catch (e) {
        this.buildError = e.message;
      } finally {
        this.savingBuild = false;
      }
    },
    async loadNetworkSettings() {
      try {
        const settings = await api.getSettings();
        this.networkSettings.network_mode = settings.network_mode || 'direct';
      } catch {
        // settings may not exist yet
      }
      try {
        this.networkInfo = await api.getNetworkInfo();
      } catch {
        // non-fatal — the panel just won't render the LAN/ports table
      }
    },
    async saveNetworkSettings() {
      this.netError = null;
      this.netSuccess = null;
      this.savingNetwork = true;
      try {
        await api.updateSettings({ network_mode: this.networkSettings.network_mode });
        this.netSuccess = 'Network settings saved';
      } catch (e) {
        this.netError = e.message;
      } finally {
        this.savingNetwork = false;
      }
    },
    async loadStagingSettings() {
      try {
        const settings = await api.getSettings();
        this.stagingSettings.staging_root_domain = settings.staging_root_domain || '';
      } catch {
        // settings may not exist yet
      }
    },
    async saveStagingSettings() {
      this.stagingError = null;
      this.stagingSuccess = null;
      this.savingStaging = true;
      try {
        await api.updateSettings({ staging_root_domain: this.stagingSettings.staging_root_domain.trim().toLowerCase() });
        this.stagingSuccess = 'Staging settings saved';
      } catch (e) {
        this.stagingError = e.message;
      } finally {
        this.savingStaging = false;
      }
    },
    async loadConstructionSettings() {
      try {
        const settings = await api.getSettings();
        this.constructionSettings.construction_heading = settings.construction_heading || '';
        this.constructionSettings.construction_message = settings.construction_message || '';
        this.constructionSettings.construction_contact = settings.construction_contact || '';
      } catch {
        // settings may not exist yet — placeholders show the built-in defaults
      }
    },
    async saveConstructionSettings() {
      this.constructionError = null;
      this.constructionSuccess = null;
      this.savingConstruction = true;
      try {
        await api.updateSettings({
          construction_heading: this.constructionSettings.construction_heading.trim(),
          construction_message: this.constructionSettings.construction_message.trim(),
          construction_contact: this.constructionSettings.construction_contact.trim(),
        });
        this.constructionSuccess = 'Under-construction defaults saved';
      } catch (e) {
        this.constructionError = e.message;
      } finally {
        this.savingConstruction = false;
      }
    },
    async loadLanSettings() {
      try {
        const settings = await api.getSettings();
        this.lanSettings.lan_bind_ip = settings.lan_bind_ip || '';
      } catch {
        // settings may not exist yet
      }
      try {
        const info = await api.getNetworkInfo();
        this.lanCandidates = info.lanCandidates || [];
      } catch {
        // non-fatal — just no detected-IP hints
      }
    },
    async saveLanSettings() {
      this.lanError = null;
      this.lanSuccess = null;
      this.savingLan = true;
      try {
        await api.updateSettings({ lan_bind_ip: this.lanSettings.lan_bind_ip.trim() });
        this.lanSuccess = 'LAN settings saved';
      } catch (e) {
        this.lanError = e.message;
      } finally {
        this.savingLan = false;
      }
    },
    async runDockerCleanup() {
      this.cleanupError = null;
      this.cleanupSuccess = null;
      this.cleanupSummary = null;

      const volumeWarning = this.cleanupIncludeVolumes
        ? ' This will also remove any unused Docker volumes.'
        : '';
      if (!confirm(`Run Docker cleanup now?${volumeWarning} Running containers are not removed.`)) return;

      this.runningCleanup = true;
      try {
        const result = await api.dockerCleanup({ include_volumes: this.cleanupIncludeVolumes });
        this.cleanupSummary = result;
        this.cleanupSuccess = 'Docker cleanup completed';
      } catch (e) {
        this.cleanupError = e.message;
      } finally {
        this.runningCleanup = false;
      }
    },
    async loadUpdateStatus() {
      try {
        const status = await api.getSelfUpdateStatus();
        this.updateStatus = status;
        this.updateError = null;
        if (status.status === 'running') {
          this.schedulePoll(3000);
        } else {
          this.updatePolling = false;
        }
      } catch (e) {
        if (this.updatePolling) {
          // Expected during the restart window — beachhead-api itself may be
          // rebuilding right now. Keep trying instead of showing an error.
          this.schedulePoll(2000);
        } else {
          this.updateError = e.message;
        }
      } finally {
        this.$nextTick(this.scrollUpdateLog);
      }
    },
    schedulePoll(delay) {
      this.updatePolling = true;
      clearTimeout(this.updatePollTimer);
      this.updatePollTimer = setTimeout(() => this.loadUpdateStatus(), delay);
    },
    scrollUpdateLog() {
      const el = this.$refs.updateLog;
      if (el) el.scrollTop = el.scrollHeight;
    },
    async triggerUpdate() {
      if (!confirm('This pulls the latest code, rebuilds, and restarts Beachhead — including this dashboard and every app behind it, briefly. Continue?')) return;
      this.updateError = null;
      this.updateStarting = true;
      try {
        await api.startSelfUpdate();
        this.updateStatus = { status: 'running', log: '' };
        this.schedulePoll(1500);
      } catch (e) {
        this.updateError = e.message;
      } finally {
        this.updateStarting = false;
      }
    },
    reloadPage() {
      window.location.reload();
    },
  },
};
</script>
