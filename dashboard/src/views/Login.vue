<template>
  <div style="max-width: 400px; margin: 4rem auto;">
    <h2 style="margin-bottom: 0.5rem;">Sign In</h2>
    <p style="color: var(--muted); margin-bottom: 1.5rem;">Log in to your Beachhead instance.</p>

    <div v-if="error" style="color: var(--danger); margin-bottom: 1rem;">{{ error }}</div>

    <form @submit.prevent="submit" class="card">
      <div class="form-group">
        <label>Username</label>
        <input v-model="username" required autocomplete="username" />
      </div>
      <div class="form-group">
        <label>Password</label>
        <input v-model="password" type="password" required autocomplete="current-password" />
      </div>
      <button class="btn" type="submit" :disabled="submitting" style="width: 100%;">
        {{ submitting ? 'Signing in...' : 'Sign In' }}
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
    error: null,
    submitting: false,
  }),
  methods: {
    async submit() {
      this.error = null;
      this.submitting = true;
      try {
        await api.login({ username: this.username, password: this.password });
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
