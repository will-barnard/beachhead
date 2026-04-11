<template>
  <div style="max-width: 400px; margin: 4rem auto;">
    <h2 style="margin-bottom: 0.5rem;">Create Admin Account</h2>
    <p style="color: var(--muted); margin-bottom: 1.5rem;">
      Set up the first account to secure your Beachhead instance.
    </p>

    <div v-if="error" style="color: var(--danger); margin-bottom: 1rem;">{{ error }}</div>

    <form @submit.prevent="submit" class="card">
      <div class="form-group">
        <label>Username</label>
        <input v-model="username" required autocomplete="username" />
      </div>
      <div class="form-group">
        <label>Password</label>
        <input v-model="password" type="password" required minlength="8" autocomplete="new-password" />
        <small style="color: var(--muted);">At least 8 characters</small>
      </div>
      <div class="form-group">
        <label>Confirm Password</label>
        <input v-model="confirmPassword" type="password" required minlength="8" autocomplete="new-password" />
      </div>
      <button class="btn" type="submit" :disabled="submitting" style="width: 100%;">
        {{ submitting ? 'Creating...' : 'Create Admin Account' }}
      </button>
    </form>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  data: () => ({
    username: '',
    password: '',
    confirmPassword: '',
    error: null,
    submitting: false,
  }),
  async mounted() {
    // If not in bootstrap mode, redirect home
    try {
      const status = await api.getBootstrapStatus();
      if (!status.bootstrap) {
        this.$router.replace('/');
      }
    } catch {
      // ignore
    }
  },
  methods: {
    async submit() {
      this.error = null;

      if (this.password !== this.confirmPassword) {
        this.error = 'Passwords do not match';
        return;
      }

      this.submitting = true;
      try {
        await api.setupAdmin({ username: this.username, password: this.password });
        this.$router.push('/');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  },
};
</script>
