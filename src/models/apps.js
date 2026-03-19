const db = require('../db');

const Apps = {
  async create({ name, repo_url, domain, branch, public_service, public_port, auto_deploy, stop_previous, webhook_secret, system_app }) {
    const { rows } = await db.query(
      `INSERT INTO apps (name, repo_url, domain, branch, public_service, public_port, auto_deploy, stop_previous, webhook_secret, system_app)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [name, repo_url, domain, branch || 'main', public_service, public_port, auto_deploy !== false, stop_previous !== false, webhook_secret, system_app || false]
    );
    return rows[0];
  },

  async findAll() {
    const { rows } = await db.query('SELECT * FROM apps ORDER BY created_at DESC');
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM apps WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByRepoUrl(repoUrl) {
    const { rows } = await db.query('SELECT * FROM apps WHERE repo_url = $1', [repoUrl]);
    return rows;
  },

  async findByDomain(domain) {
    const { rows } = await db.query('SELECT * FROM apps WHERE domain = $1', [domain]);
    return rows[0] || null;
  },

  async findByName(name) {
    const { rows } = await db.query('SELECT * FROM apps WHERE name = $1', [name]);
    return rows[0] || null;
  },

  async update(id, fields) {
    const allowed = ['name', 'repo_url', 'domain', 'branch', 'public_service', 'public_port', 'auto_deploy', 'webhook_secret'];
    const sets = [];
    const values = [];
    let idx = 1;

    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = $${idx}`);
        values.push(fields[key]);
        idx++;
      }
    }

    if (sets.length === 0) return null;

    values.push(id);
    const { rows } = await db.query(
      `UPDATE apps SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async delete(id) {
    const { rows } = await db.query('DELETE FROM apps WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  },
};

module.exports = Apps;
