const db = require('../db');

const Settings = {
  async get(key) {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  },

  async set(key, value) {
    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value],
    );
  },

  async getAll() {
    const { rows } = await db.query('SELECT key, value FROM settings ORDER BY key');
    const result = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  },

  async getBuildMode() {
    return (await this.get('build_mode')) || 'local';
  },

  async getNetworkMode() {
    return (await this.get('network_mode')) || 'direct';
  },

  async getRegistryConfig() {
    const type = (await this.get('registry_type')) || 'generic';

    if (type === 'ghcr') {
      const owner = (await this.get('ghcr_owner')) || '';
      const token = (await this.get('ghcr_token')) || '';
      return {
        url: owner ? `ghcr.io/${owner}` : '',
        user: owner,
        password: token,
      };
    }

    // Generic registry
    return {
      url: (await this.get('registry_url')) || '',
      user: (await this.get('registry_user')) || '',
      password: (await this.get('registry_password')) || '',
    };
  },
};

module.exports = Settings;
