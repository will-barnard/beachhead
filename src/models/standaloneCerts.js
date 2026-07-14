const db = require('../db');

/**
 * Standalone certificates — Let's Encrypt certs that are NOT tied to any app
 * Beachhead hosts. Because the Beachhead machine owns ports 80/443 and runs
 * acme-companion, it can validate and auto-renew certs for arbitrary hostnames
 * (e.g. a NAS behind the same public IP) which are then downloaded and
 * installed on the other machine.
 *
 * `domains` holds one or more hostnames covered by a single certificate (the
 * first is treated as the primary / SAN subject used for the cert directory).
 */
const StandaloneCerts = {
  async findAll() {
    const { rows } = await db.query('SELECT * FROM standalone_certs ORDER BY created_at DESC');
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM standalone_certs WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async create({ name, domains }) {
    const { rows } = await db.query(
      `INSERT INTO standalone_certs (name, domains) VALUES ($1, $2) RETURNING *`,
      [name || null, domains]
    );
    return rows[0];
  },

  async delete(id) {
    const { rows } = await db.query('DELETE FROM standalone_certs WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  },
};

module.exports = StandaloneCerts;
