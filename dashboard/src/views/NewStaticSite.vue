<template>
  <div>
    <h2 style="margin-bottom:1.5rem;">New Static Site</h2>
    <HomeNetworkBanner context="static site" :domain="form.domain" />
    <div v-if="error" style="color:var(--danger); margin-bottom:1rem;">{{ error }}</div>
    <form @submit.prevent="submit" class="card">
      <div class="form-group">
        <label>Name</label>
        <input v-model="form.name" required placeholder="my-website" />
      </div>
      <div class="form-group">
        <label>Domain</label>
        <input v-model="form.domain" required placeholder="www.example.com" />
      </div>
      <button class="btn" type="submit" :disabled="submitting">
        {{ submitting ? 'Creating...' : 'Create Static Site' }}
      </button>
    </form>
  </div>
</template>

<script>
import api from '../api.js';
import HomeNetworkBanner from '../components/HomeNetworkBanner.vue';

export default {
  components: { HomeNetworkBanner },
  data: () => ({
    form: { name: '', domain: '' },
    error: null,
    submitting: false,
  }),
  methods: {
    async submit() {
      this.submitting = true;
      this.error = null;
      try {
        const site = await api.createStaticSite(this.form);
        this.$router.push(`/static-sites/${site.id}`);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  },
};
</script>
