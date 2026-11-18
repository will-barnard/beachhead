const db = require('../db');

/**
 * Storage for the system monitor.
 *
 *   monitor_samples  — one row per subject per collector tick (~1/min), kept
 *                      RAW_RETENTION_HOURS. `data` is a flat object of numbers.
 *   monitor_rollups  — 15-minute buckets (avg + max of every numeric key),
 *                      kept ROLLUP_RETENTION_DAYS. Charts over 48h read these.
 *   monitor_alerts   — open and resolved alerts. At most one open row per key
 *                      (partial unique index), so a restart can't double-open.
 *
 * Plain Postgres rather than a TSDB: at one Beachhead's scale (a few dozen
 * containers, one sample a minute) this is ~60k rows/day and stays small.
 */

const RAW_RETENTION_HOURS = 48;
const ROLLUP_RETENTION_DAYS = 30;
const ROLLUP_BUCKET = '15 minutes';

const Monitor = {
  RAW_RETENTION_HOURS,
  ROLLUP_RETENTION_DAYS,

  async insertSamples(rows) {
    if (!rows.length) return;
    // One round trip regardless of container count.
    await db.query(
      `INSERT INTO monitor_samples (ts, kind, subject, app_id, service, data)
       SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::int[], $5::text[], $6::jsonb[])`,
      [
        rows.map((r) => r.ts),
        rows.map((r) => r.kind),
        rows.map((r) => r.subject),
        rows.map((r) => r.appId ?? null),
        rows.map((r) => r.service ?? null),
        rows.map((r) => JSON.stringify(r.data)),
      ],
    );
  },

  /**
   * Time series for one subject. Uses raw samples for ranges inside the raw
   * retention window, rollups beyond it. Returns [{ t, ...fields }].
   */
  async series({ kind, subject, sinceMs, fields }) {
    const since = new Date(Date.now() - sinceMs);
    const useRaw = sinceMs <= RAW_RETENTION_HOURS * 3600 * 1000;
    const { rows } = useRaw
      ? await db.query(
        `SELECT ts AS t, data FROM monitor_samples
          WHERE kind = $1 AND subject = $2 AND ts >= $3 ORDER BY ts`,
        [kind, subject, since],
      )
      : await db.query(
        `SELECT bucket AS t, avg AS data FROM monitor_rollups
          WHERE kind = $1 AND subject = $2 AND bucket >= $3 ORDER BY bucket`,
        [kind, subject, since],
      );
    return rows.map((r) => {
      const out = { t: new Date(r.t).getTime() };
      for (const f of fields) out[f] = r.data?.[f] ?? null;
      return out;
    });
  },

  /** Raw points for trend fitting (disk-full projection, leak detection). */
  async recentPoints({ kind, subject, field, sinceMs }) {
    const { rows } = await db.query(
      `SELECT ts, (data->>$3)::float8 AS v FROM monitor_samples
        WHERE kind = $1 AND subject = $2 AND ts >= $4 AND data ? $3 ORDER BY ts`,
      [kind, subject, field, new Date(Date.now() - sinceMs)],
    );
    return rows.filter((r) => r.v != null).map((r) => ({ t: new Date(r.ts).getTime(), v: r.v }));
  },

  /**
   * Roll raw samples into 15-minute buckets. Recomputes the last two hours
   * each run (idempotent via ON CONFLICT) so a late or missed run never
   * leaves a hole, then prunes past retention.
   */
  async rollupAndPrune() {
    await db.query(
      `INSERT INTO monitor_rollups (bucket, kind, subject, app_id, service, avg, max)
       SELECT bucket, kind, subject, MAX(app_id), MAX(service),
              jsonb_object_agg(key, avg_v), jsonb_object_agg(key, max_v)
         FROM (
           SELECT date_bin('${ROLLUP_BUCKET}', s.ts, TIMESTAMPTZ 'epoch') AS bucket,
                  s.kind, s.subject, s.app_id, s.service, e.key,
                  ROUND(AVG((e.value)::numeric), 2) AS avg_v,
                  MAX((e.value)::numeric) AS max_v
             FROM monitor_samples s, jsonb_each(s.data) e
            WHERE s.ts >= NOW() - INTERVAL '2 hours'
              AND jsonb_typeof(e.value) = 'number'
            GROUP BY 1, 2, 3, 4, 5, 6
         ) t
        GROUP BY bucket, kind, subject
       ON CONFLICT (bucket, kind, subject) DO UPDATE
         SET avg = EXCLUDED.avg, max = EXCLUDED.max`,
    );
    await db.query(`DELETE FROM monitor_samples WHERE ts < NOW() - INTERVAL '${RAW_RETENTION_HOURS} hours'`);
    await db.query(`DELETE FROM monitor_rollups WHERE bucket < NOW() - INTERVAL '${ROLLUP_RETENTION_DAYS} days'`);
  },

  async databaseSizeBytes() {
    const { rows } = await db.query('SELECT pg_database_size(current_database())::bigint AS size');
    return Number(rows[0]?.size || 0);
  },

  // ── Alerts ──

  async loadOpenAlerts() {
    const { rows } = await db.query('SELECT * FROM monitor_alerts WHERE resolved_at IS NULL ORDER BY opened_at');
    return rows;
  },

  async openAlert({ key, rule, severity, subject, message, details }) {
    // ON CONFLICT on the partial unique index: if another path opened the same
    // key a moment ago, refresh it instead of erroring.
    const { rows } = await db.query(
      `INSERT INTO monitor_alerts (key, rule, severity, subject, message, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) WHERE resolved_at IS NULL DO UPDATE
         SET severity = EXCLUDED.severity, message = EXCLUDED.message,
             details = EXCLUDED.details, last_seen_at = NOW()
       RETURNING *`,
      [key, rule, severity, subject || null, message, details ? JSON.stringify(details) : null],
    );
    return rows[0];
  },

  async touchAlert(id, { severity, message, details }) {
    const { rows } = await db.query(
      `UPDATE monitor_alerts SET severity = $2, message = $3, details = $4, last_seen_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, severity, message, details ? JSON.stringify(details) : null],
    );
    return rows[0];
  },

  async markNotified(id, severity) {
    await db.query('UPDATE monitor_alerts SET notified_severity = $2 WHERE id = $1', [id, severity]);
  },

  async resolveAlert(id, resolvedBy = 'auto') {
    const { rows } = await db.query(
      `UPDATE monitor_alerts SET resolved_at = NOW(), resolved_by = $2
        WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
      [id, resolvedBy],
    );
    return rows[0] || null;
  },

  async listAlerts({ status = 'all', limit = 100 } = {}) {
    const where = status === 'open' ? 'WHERE resolved_at IS NULL'
      : status === 'resolved' ? 'WHERE resolved_at IS NOT NULL' : '';
    const { rows } = await db.query(
      `SELECT * FROM monitor_alerts ${where} ORDER BY opened_at DESC LIMIT $1`,
      [Math.min(Math.max(1, Number(limit) || 100), 500)],
    );
    return rows;
  },

  async pruneResolvedAlerts(days = 90) {
    await db.query(`DELETE FROM monitor_alerts WHERE resolved_at < NOW() - ($1 || ' days')::interval`, [days]);
  },

  // ── Deployment checks (read-only views over the deployments table) ──

  /** Non-terminal deployments older than the threshold. */
  async stuckDeployments(minutes) {
    const { rows } = await db.query(
      `SELECT d.id, d.app_id, d.state, d.created_at, a.name AS app_name
         FROM deployments d JOIN apps a ON a.id = d.app_id
        WHERE d.state NOT IN ('SUCCESS', 'FAILED')
          AND d.created_at < NOW() - ($1 || ' minutes')::interval`,
      [minutes],
    );
    return rows;
  },

  /**
   * Apps whose most recent finished deployment failed. A user cancel also
   * ends in FAILED, so those are excluded — cancelling isn't an incident.
   */
  async appsWithFailedLatestDeploy() {
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (d.app_id) d.app_id, d.id, d.state, d.created_at, d.logs, a.name AS app_name
           FROM deployments d JOIN apps a ON a.id = d.app_id
          WHERE d.state IN ('SUCCESS', 'FAILED')
          ORDER BY d.app_id, d.id DESC
       ) latest
       WHERE state = 'FAILED' AND COALESCE(logs, '') NOT LIKE '%Cancelled by user%'`,
    );
    return rows.map(({ logs, ...r }) => ({ ...r, lastLogLine: lastLine(logs) }));
  },
};

function lastLine(text) {
  const lines = String(text || '').trim().split('\n');
  return (lines[lines.length - 1] || '').slice(0, 300);
}

module.exports = Monitor;
