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
    const allowed = ['name', 'repo_url', 'domain', 'branch', 'public_service', 'public_port', 'auto_deploy', 'webhook_secret', 'www_redirect', 'active_deployment_id', 'paused', 'paused_redirect_url', 'staging_subdomain', 'proxy_network_name', 'on_demand', 'idle_timeout_seconds', 'last_active_at', 'auto_paused', 'always_on_services', 'wake_page_html'];
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

  /**
   * Return ids of apps whose primary domain or any endpoint domain matches
   * one of the given hostnames. Used by the activity tracker to translate
   * nginx Host headers into app rows.
   */
  async findIdsByAnyDomain(domains) {
    if (!domains || domains.length === 0) return [];
    // Normalise to lowercase on both sides — nginx Host headers are
    // case-insensitive and we don't enforce case at app-create time.
    const lower = domains.map(d => String(d || '').toLowerCase());
    const { rows } = await db.query(
      `SELECT DISTINCT a.id
         FROM apps a
         LEFT JOIN app_endpoints e ON e.app_id = a.id
        WHERE LOWER(a.domain) = ANY($1::text[])
           OR LOWER(e.domain) = ANY($1::text[])`,
      [lower]
    );
    return rows.map(r => r.id);
  },

  /**
   * Bump last_active_at = NOW() for the given app ids. Only touches apps
   * whose `on_demand` is true so we don't write to rows that don't care.
   */
  async bumpLastActive(appIds) {
    if (!appIds || appIds.length === 0) return 0;
    const { rowCount } = await db.query(
      `UPDATE apps SET last_active_at = NOW()
        WHERE id = ANY($1::int[]) AND on_demand = TRUE`,
      [appIds]
    );
    return rowCount;
  },

  /**
   * Apps that are candidates for the idle sweep — on-demand, not currently
   * paused (manually or automatically), not system apps.
   */
  async findIdleSweepCandidates() {
    const { rows } = await db.query(
      `SELECT * FROM apps
        WHERE on_demand = TRUE
          AND paused = FALSE
          AND auto_paused = FALSE
          AND COALESCE(system_app, FALSE) = FALSE`
    );
    return rows;
  },
};

module.exports = Apps;
