const db = require('../db');

/**
 * Static LAN port mappings for an app's compose services.
 *
 * By default Beachhead publishes no host ports — traffic is routed by
 * nginx-proxy via VIRTUAL_HOST. A ServicePort opts a single service into a
 * fixed host-port binding so it can be reached directly over the LAN at
 * `<lan_bind_ip>:<host_port>`. One row per (app, service).
 */
const ServicePorts = {
  async findByAppId(appId) {
    const { rows } = await db.query(
      'SELECT * FROM service_ports WHERE app_id = $1 ORDER BY service',
      [appId]
    );
    return rows;
  },

  /**
   * Enabled port mappings for an app — the ones that should actually be
   * injected into the compose override.
   */
  async findEnabledByAppId(appId) {
    const { rows } = await db.query(
      'SELECT * FROM service_ports WHERE app_id = $1 AND enabled = TRUE ORDER BY service',
      [appId]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM service_ports WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByAppService(appId, service) {
    const { rows } = await db.query(
      'SELECT * FROM service_ports WHERE app_id = $1 AND service = $2',
      [appId, service]
    );
    return rows[0] || null;
  },

  /**
   * Find any *enabled* mapping already claiming a host port (across all apps).
   * Used to reject collisions before assigning a port. Pass excludeId to
   * ignore the row currently being updated.
   */
  async findEnabledByHostPort(hostPort, excludeId = null) {
    const { rows } = await db.query(
      `SELECT * FROM service_ports
        WHERE host_port = $1 AND enabled = TRUE AND ($2::int IS NULL OR id <> $2)`,
      [hostPort, excludeId]
    );
    return rows[0] || null;
  },

  /**
   * Upsert the mapping for (app_id, service). Creates it if missing, otherwise
   * updates host_port / container_port / enabled.
   */
  async upsert({ app_id, service, host_port, container_port, enabled }) {
    const { rows } = await db.query(
      `INSERT INTO service_ports (app_id, service, host_port, container_port, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, service)
       DO UPDATE SET host_port = $3, container_port = $4, enabled = $5
       RETURNING *`,
      [app_id, service, host_port, container_port || 80, enabled !== false]
    );
    return rows[0];
  },

  async delete(id) {
    const { rows } = await db.query('DELETE FROM service_ports WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  },
};

module.exports = ServicePorts;
