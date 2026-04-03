const db = require('../db');

const StaticSites = {
  async create({ name, domain }) {
    const { rows } = await db.query(
      `INSERT INTO static_sites (name, domain) VALUES ($1, $2) RETURNING *`,
      [name, domain]
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

  async update(id, fields) {
    const allowed = ['name', 'domain', 'www_redirect'];
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

    sets.push(`updated_at = NOW()`);
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
