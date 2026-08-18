const db = require('../db');

const EnvVars = {
  /**
   * Create or update an env var.
   *
   * Cannot use ON CONFLICT (app_id, key, target_service): Postgres treats NULLs
   * as distinct in a unique constraint, so the constraint never matches a
   * GLOBAL var (target_service IS NULL). Every save of a global therefore
   * INSERTed a new row instead of updating, quietly accumulating duplicates for
   * the same key - and which one won at deploy time was down to row order.
   *
   * Explicit update-then-insert handles NULL correctly without needing a schema
   * change on a live install.
   */
  async set({ app_id, key, value, target_service }) {
    const target = target_service || null;

    const updated = await db.query(
      `UPDATE env_vars
          SET value = $3
        WHERE app_id = $1
          AND key = $2
          AND target_service IS NOT DISTINCT FROM $4
        RETURNING *`,
      [app_id, key, value, target]
    );
    if (updated.rows.length > 0) {
      // Clear any duplicates left behind by the previous behaviour.
      if (updated.rows.length > 1) {
        const keepId = updated.rows[0].id;
        await db.query(
          `DELETE FROM env_vars
            WHERE app_id = $1 AND key = $2
              AND target_service IS NOT DISTINCT FROM $3
              AND id <> $4`,
          [app_id, key, target, keepId]
        );
      }
      return updated.rows[0];
    }

    const inserted = await db.query(
      `INSERT INTO env_vars (app_id, key, value, target_service)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [app_id, key, value, target]
    );
    return inserted.rows[0];
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
