const db = require('../db');

const EnvVars = {
  async set({ app_id, key, value, target_service }) {
    const { rows } = await db.query(
      `INSERT INTO env_vars (app_id, key, value, target_service)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (app_id, key, target_service)
       DO UPDATE SET value = EXCLUDED.value
       RETURNING *`,
      [app_id, key, value, target_service || null]
    );
    return rows[0];
  },

  async getByAppId(appId) {
    const { rows } = await db.query(
      'SELECT * FROM env_vars WHERE app_id = $1 ORDER BY key',
      [appId]
    );
    return rows;
  },

  async delete(id) {
    const { rows } = await db.query(
      'DELETE FROM env_vars WHERE id = $1 RETURNING *',
      [id]
    );
    return rows[0] || null;
  },

  async deleteByAppAndKey(appId, key, targetService) {
    const { rows } = await db.query(
      'DELETE FROM env_vars WHERE app_id = $1 AND key = $2 AND (target_service = $3 OR ($3 IS NULL AND target_service IS NULL)) RETURNING *',
      [appId, key, targetService || null]
    );
    return rows[0] || null;
  },
};

module.exports = EnvVars;
