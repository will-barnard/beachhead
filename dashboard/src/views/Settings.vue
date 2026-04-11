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
            <td style="padding: 0.5rem; text-align: right;">
              <button v-if="u.id !== currentUserId" class="btn btn-danger btn-sm" @click="removeUser(u)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>

      <h4 style="margin-bottom: 0.75rem;">Add User</h4>
      <div v-if="error" style="color: var(--danger); margin-bottom: 0.75rem;">{{ error }}</div>
      <div v-if="success" style="color: var(--success); margin-bottom: 0.75rem;">{{ success }}</div>

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
  }),
  async mounted() {
    await this.loadUsers();
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
    async logout() {
      try {
        await api.logout();
      } catch {
        // ignore
      }
      this.$router.push('/login');
    },
  },
};
</script>
