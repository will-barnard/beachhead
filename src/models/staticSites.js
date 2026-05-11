const db = require('../db');

// Columns that callers may write through create() / update().
// Keeping this here (not duplicated per-method) makes the source-type
// expansion (migration 022) less error-prone.
const WRITABLE = [
  'name',
  'domain',
  'www_redirect',
  'source_type',
  'repo_url',
  'branch',
  'subpath',
  'build_command',
  'build_image',
  'webhook_secret',
  'auto_deploy',
];

// Columns that the deployer writes — separated from WRITABLE so a misbehaving
// API caller can't overwrite deploy bookkeeping by stuffing fields into PUT.
const DEPLOY_BOOKKEEPING = [
  'last_deploy_state',
  'last_deploy_at',
  'last_commit_hash',
  'last_deploy_log',
];

const StaticSites = {
  async create(fields) {
    // Always set source_type explicitly — defaults to 'upload' to keep parity
    // with the pre-migration behaviour, callers opt in to 'git'.
    const cols = ['name', 'domain'];
    const placeholders = ['$1', '$2'];
    const values = [fields.name, fields.domain];
    let idx = 3;

    const optional = [
      'source_type', 'repo_url', 'branch', 'subpath',
      'build_command', 'build_image', 'webhook_secret', 'auto_deploy',
    ];
    for (const key of optional) {
      if (fields[key] !== undefined && fields[key] !== null) {
        cols.push(key);
        placeholders.push(`$${idx++}`);
        values.push(fields[key]);
      }
    }

    const { rows } = await db.query(
      `INSERT INTO static_sites (${cols.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values
    );
    return rows[0];
  },

  async findAll() {
    const { rows } = await db.query('SELECT * FROM static_sites ORDER BY created_at DESC');
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM static_sites WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByDomain(domain) {
    const { rows } = await db.query('SELECT * FROM static_sites WHERE domain = $1', [domain]);
    return rows[0] || null;
  },

  /**
   * Lookup git-backed static sites whose repo_url matches. Used by the GitHub
   * webhook router. Mirrors Apps.findByRepoUrl. Returns an array (a single
   * repo may, in theory, be wired to multiple sites on different branches).
   */
  async findByRepoUrl(repoUrl) {
    const { rows } = await db.query(
      `SELECT * FROM static_sites WHERE source_type = 'git' AND repo_url = $1`,
      [repoUrl]
    );
    return rows;
  },

  async update(id, fields) {
    const sets = [];
    const values = [];
    let idx = 1;

    for (const key of WRITABLE) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = $${idx}`);
        values.push(fields[key]);
        idx++;
      }
    }

    if (sets.length === 0) return null;

    sets.push(`updated_at = NOW()`);
    values.push(id);

    const { rows } = await db.query(
      `UPDATE static_sites SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  /**
   * Update deploy bookkeeping fields. Kept distinct from update() so the
   * deployer can't accidentally bump updated_at (which gates "needs reverify"
   * UX) and so API clients can't write these via PUT.
   */
  async setDeployState(id, fields) {
    const sets = [];
    const values = [];
    let idx = 1;

    for (const key of DEPLOY_BOOKKEEPING) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = $${idx}`);
        values.push(fields[key]);
        idx++;
      }
    }
    if (sets.length === 0) return null;

    values.push(id);
    const { rows } = await db.query(
      `UPDATE static_sites SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async delete(id) {
    await db.query('DELETE FROM static_sites WHERE id = $1', [id]);
  },
};

module.exports = StaticSites;
