const db = require('../db');

const STATES = {
  PENDING: 'PENDING',
  CLONING: 'CLONING',
  ENV_INJECTION: 'ENV_INJECTION',
  BUILDING: 'BUILDING',
  STARTING_CONTAINERS: 'STARTING_CONTAINERS',
  PROXY_SETUP: 'PROXY_SETUP',
  VERIFY_HEALTH: 'VERIFY_HEALTH',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
};

const STATE_ORDER = [
  STATES.PENDING,
  STATES.CLONING,
  STATES.ENV_INJECTION,
  STATES.BUILDING,
  STATES.STARTING_CONTAINERS,
  STATES.PROXY_SETUP,
  STATES.VERIFY_HEALTH,
  STATES.SUCCESS,
];

const Deployments = {
  STATES,
  STATE_ORDER,

  async create({ app_id, commit_hash }) {
    const { rows } = await db.query(
      `INSERT INTO deployments (app_id, commit_hash, state)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [app_id, commit_hash || null, STATES.PENDING]
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM deployments WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByAppId(appId, limit = 20) {
    const { rows } = await db.query(
      'SELECT * FROM deployments WHERE app_id = $1 ORDER BY created_at DESC LIMIT $2',
      [appId, limit]
    );
    return rows;
  },

  async getNextPending() {
    const { rows } = await db.query(
      `UPDATE deployments
       SET state = $1
       WHERE id = (
         SELECT id FROM deployments
         WHERE state = $2
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [STATES.CLONING, STATES.PENDING]
    );
    return rows[0] || null;
  },

  async updateState(id, state, logEntry) {
    const logClause = logEntry
      ? `, logs = COALESCE(logs, '') || $3`
      : '';
    const params = logEntry ? [state, id, logEntry + '\n'] : [state, id];
    const { rows } = await db.query(
      `UPDATE deployments SET state = $1${logClause} WHERE id = $2 RETURNING *`,
      params
    );
    return rows[0] || null;
  },

  async appendLog(id, logEntry) {
    await db.query(
      `UPDATE deployments SET logs = COALESCE(logs, '') || $1 WHERE id = $2`,
      [logEntry + '\n', id]
    );
  },

  /**
   * Find the last successful deployment for an app, excluding a given id.
   * Used to locate the old deploy dir when tearing down before a new deploy.
   */
  async findLastSuccessful(appId, excludeId) {
    const { rows } = await db.query(
      `SELECT * FROM deployments
       WHERE app_id = $1 AND id != $2 AND state = 'SUCCESS'
       ORDER BY created_at DESC
       LIMIT 1`,
      [appId, excludeId]
    );
    return rows[0] || null;
  },

  /**
   * Check if there's an active (non-terminal) deployment for the given app,
   * excluding a specific deployment id.
   */
  async hasActiveForApp(appId, excludeId) {
    const { rows } = await db.query(
      `SELECT id FROM deployments
       WHERE app_id = $1 AND id != $2
         AND state NOT IN ('PENDING', 'SUCCESS', 'FAILED')
       LIMIT 1`,
      [appId, excludeId]
    );
    return rows.length > 0;
  },

  /**
   * Force-fail all active (non-terminal, non-pending) deployments for a given app.
   * Returns the number of cancelled rows.
   */
  async cancelActiveForApp(appId) {
    const { rowCount } = await db.query(
      `UPDATE deployments
       SET state = 'FAILED',
           logs = COALESCE(logs, '') || '[FAILED] Cancelled by user\n'
       WHERE app_id = $1
         AND state NOT IN ('PENDING', 'SUCCESS', 'FAILED')`,
      [appId]
    );
    return rowCount;
  },

  /**
   * Mark deployments stuck in intermediate states for longer than thresholdMs as FAILED.
   * Returns the number of recovered rows.
   */
  async failStale(thresholdMs) {
    const { rowCount } = await db.query(
      `UPDATE deployments
       SET state = 'FAILED',
           logs = COALESCE(logs, '') || '[FAILED] Recovered: deployment was stuck in intermediate state\n'
       WHERE state NOT IN ('PENDING', 'SUCCESS', 'FAILED')
         AND created_at < NOW() - ($1 || ' milliseconds')::interval`,
      [thresholdMs]
    );
    return rowCount;
  },
};

module.exports = Deployments;
