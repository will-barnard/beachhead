const db = require('../db');

const AppEndpoints = {
  async create({ app_id, service, domain, port }) {
    const { rows } = await db.query(
      `INSERT INTO app_endpoints (app_id, service, domain, port)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [app_id, service, domain, port || 80]
    );
    return rows[0];
  },

  async findByAppId(appId) {
    const { rows } = await db.query(
      'SELECT * FROM app_endpoints WHERE app_id = $1 ORDER BY created_at',
      [appId]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM app_endpoints WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByDomain(domain) {
    const { rows } = await db.query('SELECT * FROM app_endpoints WHERE domain = $1', [domain]);
    return rows[0] || null;
  },

  async update(id, fields) {
    const allowed = ['service', 'domain', 'port', 'www_redirect'];
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
      `UPDATE app_endpoints SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async delete(id) {
    const { rows } = await db.query('DELETE FROM app_endpoints WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  },
};

module.exports = AppEndpoints;
