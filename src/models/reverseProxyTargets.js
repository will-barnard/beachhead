const db = require('../db');

/**
 * Reverse Proxy Targets — forward 80/443 traffic for one or more domains to
 * an arbitrary host:port that Beachhead itself does not run (e.g. a NAS on
 * the same LAN). See services/reverseProxyTargets.js for the runtime side
 * (the nginx sidecar container that actually does the proxying).
 */

// Columns callers may write through create() / update().
const WRITABLE = [
  'name',
  'domains',
  'target_scheme',
  'target_host',
  'target_port',
  'websocket',
  'verify_tls',
  'enabled',
];

const ReverseProxyTargets = {
  async findAll() {
    const { rows } = await db.query('SELECT * FROM reverse_proxy_targets ORDER BY created_at DESC');
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM reverse_proxy_targets WHERE id = $1', [id]);
    return rows[0] || null;
  },

  /** Any target (optionally excluding one row) that already claims `domain`. */
  async findByDomain(domain, excludeId = null) {
    const { rows } = await db.query(
      `SELECT * FROM reverse_proxy_targets WHERE $1 = ANY(domains) AND ($2::int IS NULL OR id != $2)`,
      [domain, excludeId]
    );
    return rows[0] || null;
  },

  async create(fields) {
    const {
      name = null,
      domains,
      target_scheme = 'http',
      target_host,
      target_port,
      websocket = false,
      verify_tls = true,
      enabled = true,
    } = fields;

    const { rows } = await db.query(
      `INSERT INTO reverse_proxy_targets
         (name, domains, target_scheme, target_host, target_port, websocket, verify_tls, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name, domains, target_scheme, target_host, target_port, websocket, verify_tls, enabled]
    );
    return rows[0];
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

    sets.push('updated_at = NOW()');
    values.push(id);

    const { rows } = await db.query(
      `UPDATE reverse_proxy_targets SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async delete(id) {
    const { rows } = await db.query('DELETE FROM reverse_proxy_targets WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  },
};

module.exports = ReverseProxyTargets;
