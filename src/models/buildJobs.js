const db = require('../db');

const STATES = {
  PENDING: 'PENDING',
  CLAIMED: 'CLAIMED',
  BUILDING: 'BUILDING',
  PUSHING: 'PUSHING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
};

const BuildJobs = {
  STATES,

  async create({ deployment_id, app_id, service, dockerfile, build_context, image_tag }) {
    const { rows } = await db.query(
      `INSERT INTO build_jobs (deployment_id, app_id, service, dockerfile, build_context, image_tag)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [deployment_id, app_id, service, dockerfile || 'Dockerfile', build_context || '.', image_tag],
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM build_jobs WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByDeploymentId(deploymentId) {
    const { rows } = await db.query(
      'SELECT * FROM build_jobs WHERE deployment_id = $1 ORDER BY id',
      [deploymentId],
    );
    return rows;
  },

  /**
   * Claim the next pending build job (atomic).
   * Returns the job or null if none available.
   */
  async claimNext(workerId) {
    const { rows } = await db.query(
      `UPDATE build_jobs
       SET state = $1, worker_id = $2, started_at = NOW()
       WHERE id = (
         SELECT id FROM build_jobs
         WHERE state = $3
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [STATES.CLAIMED, workerId, STATES.PENDING],
    );
    if (!rows[0]) return null;

    // Enrich with repo info from the app so the worker can clone
    const { rows: appRows } = await db.query(
      'SELECT repo_url, branch FROM apps WHERE id = $1',
      [rows[0].app_id],
    );
    return { ...rows[0], ...(appRows[0] || {}) };
  },

  async updateState(id, state, logEntry) {
    const completedClause = (state === STATES.SUCCESS || state === STATES.FAILED)
      ? ', completed_at = NOW()'
      : '';
    const logClause = logEntry ? `, logs = COALESCE(logs, '') || $3` : '';
    const params = logEntry ? [state, id, logEntry + '\n'] : [state, id];
    const { rows } = await db.query(
      `UPDATE build_jobs SET state = $1${logClause}${completedClause} WHERE id = $2 RETURNING *`,
      params,
    );
    return rows[0] || null;
  },

  /**
   * Check if all build jobs for a deployment are complete.
   * Returns { done: bool, success: bool, failed: [jobs] }
   */
  async checkDeploymentStatus(deploymentId) {
    const jobs = await this.findByDeploymentId(deploymentId);
    if (jobs.length === 0) return { done: true, success: true, failed: [] };

    const pending = jobs.filter(j => ![STATES.SUCCESS, STATES.FAILED].includes(j.state));
    const failed = jobs.filter(j => j.state === STATES.FAILED);

    return {
      done: pending.length === 0,
      success: failed.length === 0 && pending.length === 0,
      failed,
    };
  },

  /**
   * Fail all pending/in-progress build jobs for a deployment.
   */
  async failAllForDeployment(deploymentId, reason) {
    await db.query(
      `UPDATE build_jobs SET state = $1, completed_at = NOW(),
       logs = COALESCE(logs, '') || $2
       WHERE deployment_id = $3 AND state NOT IN ($4, $5)`,
      [STATES.FAILED, `[FAILED] ${reason}\n`, deploymentId, STATES.SUCCESS, STATES.FAILED],
    );
  },
};

module.exports = BuildJobs;
