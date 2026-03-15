const db = require('../db');

/**
 * Parse raw .env file text into an array of { key, value } objects.
 * Handles comments, blank lines, quoted values, and inline comments.
 */
function parseDotenv(raw) {
  const result = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comment (unquoted values)
      const commentIdx = value.indexOf(' #');
      if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    }

    result.push({ key, value });
  }
  return result;
}

const EnvFiles = {
  async create({ app_id, path }) {
    const { rows } = await db.query(
      `INSERT INTO env_files (app_id, path) VALUES ($1, $2)
       ON CONFLICT (app_id, path) DO UPDATE SET path = EXCLUDED.path
       RETURNING *`,
      [app_id, path]
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM env_files WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async getByAppId(appId) {
    const { rows } = await db.query(
      `SELECT ef.*, 
              COALESCE(json_agg(ev ORDER BY ev.key) FILTER (WHERE ev.id IS NOT NULL), '[]') AS vars
       FROM env_files ef
       LEFT JOIN env_vars ev ON ev.env_file_id = ef.id
       WHERE ef.app_id = $1
       GROUP BY ef.id
       ORDER BY ef.path`,
      [appId]
    );
    return rows;
  },

  /**
   * Replace all vars for an env file by parsing raw dotenv content.
   * Returns the saved file with parsed vars.
   */
  async saveContent({ fileId, rawContent }) {
    const parsed = parseDotenv(rawContent);

    await db.query('BEGIN');
    try {
      // Delete existing vars for this file
      await db.query('DELETE FROM env_vars WHERE env_file_id = $1', [fileId]);

      // Insert parsed vars
      for (const { key, value } of parsed) {
        await db.query(
          `INSERT INTO env_vars (app_id, key, value, env_file_id)
           SELECT app_id, $2, $3, $1 FROM env_files WHERE id = $1`,
          [fileId, key, value]
        );
      }

      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }

    return this.findById(fileId);
  },

  async delete(id) {
    // env_vars with this env_file_id cascade automatically
    const { rows } = await db.query(
      'DELETE FROM env_files WHERE id = $1 RETURNING *',
      [id]
    );
    return rows[0] || null;
  },
};

module.exports = { EnvFiles, parseDotenv };
