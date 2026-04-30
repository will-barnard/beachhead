const db = require('./index');
const logger = require('../logger');

const MIGRATIONS = [
  {
    name: '001_create_apps',
    sql: `
      CREATE TABLE IF NOT EXISTS apps (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        domain TEXT NOT NULL UNIQUE,
        branch TEXT DEFAULT 'main',
        public_service TEXT,
        public_port INT,
        auto_deploy BOOLEAN DEFAULT true,
        webhook_secret TEXT,
        system_app BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `,
  },
  {
    name: '002_create_deployments',
    sql: `
      CREATE TABLE IF NOT EXISTS deployments (
        id SERIAL PRIMARY KEY,
        app_id INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        commit_hash TEXT,
        state TEXT NOT NULL DEFAULT 'PENDING',
        logs TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_deployments_app_id ON deployments(app_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_state ON deployments(state);
    `,
  },
  {
    name: '003_create_env_vars',
    sql: `
      CREATE TABLE IF NOT EXISTS env_vars (
        id SERIAL PRIMARY KEY,
        app_id INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        target_service TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(app_id, key, target_service)
      );
    `,
  },
  {
    name: '004_create_migrations_tracking',
    sql: `
      CREATE TABLE IF NOT EXISTS beachhead_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT NOW()
      );
    `,
  },
  {
    name: '005_create_env_files',
    sql: `
      CREATE TABLE IF NOT EXISTS env_files (
        id SERIAL PRIMARY KEY,
        app_id INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(app_id, path)
      );
    `,
  },
  {
    name: '006_add_env_file_id_to_env_vars',
    sql: `
      ALTER TABLE env_vars ADD COLUMN IF NOT EXISTS env_file_id INT REFERENCES env_files(id) ON DELETE CASCADE;
      CREATE UNIQUE INDEX IF NOT EXISTS env_vars_file_unique
        ON env_vars(app_id, key, env_file_id)
        WHERE env_file_id IS NOT NULL;
    `,
  },
  {
    name: '007_add_stop_previous_to_apps',
    sql: `
      ALTER TABLE apps ADD COLUMN IF NOT EXISTS stop_previous BOOLEAN DEFAULT true;
    `,
  },
  {
    name: '008_add_www_redirect_to_apps',
    sql: `
      ALTER TABLE apps ADD COLUMN IF NOT EXISTS www_redirect BOOLEAN DEFAULT false;
    `,
  },
  {
    name: '009_create_static_sites',
    sql: `
      CREATE TABLE IF NOT EXISTS static_sites (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT NOT NULL UNIQUE,
        www_redirect BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `,
  },
  {
    name: '010_create_app_endpoints',
    sql: `
      CREATE TABLE IF NOT EXISTS app_endpoints (
        id SERIAL PRIMARY KEY,
        app_id INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        domain TEXT NOT NULL UNIQUE,
        port INTEGER DEFAULT 80,
        www_redirect BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_endpoints_app_service ON app_endpoints(app_id, service);
    `,
  },
  {
    name: '011_add_active_deployment_to_apps',
    sql: `
      ALTER TABLE apps ADD COLUMN IF NOT EXISTS active_deployment_id INT REFERENCES deployments(id) ON DELETE SET NULL;
    `,
  },
  {
    name: '012_allow_multiple_endpoints_per_service',
    sql: `
      DROP INDEX IF EXISTS idx_app_endpoints_app_service;
    `,
  },
  {
    name: '013_create_users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `,
  },
  {
    name: '014_create_build_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS build_jobs (
        id SERIAL PRIMARY KEY,
        deployment_id INT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
        app_id INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        dockerfile TEXT NOT NULL DEFAULT 'Dockerfile',
        build_context TEXT NOT NULL DEFAULT '.',
        image_tag TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PENDING',
        logs TEXT DEFAULT '',
        worker_id TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_build_jobs_state ON build_jobs(state);
      CREATE INDEX IF NOT EXISTS idx_build_jobs_deployment ON build_jobs(deployment_id);
    `,
  },
  {
    name: '015_create_settings',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      INSERT INTO settings (key, value) VALUES ('build_mode', 'local') ON CONFLICT DO NOTHING;
      INSERT INTO settings (key, value) VALUES ('registry_url', '') ON CONFLICT DO NOTHING;
      INSERT INTO settings (key, value) VALUES ('registry_user', '') ON CONFLICT DO NOTHING;
      INSERT INTO settings (key, value) VALUES ('registry_password', '') ON CONFLICT DO NOTHING;
    `,
  },
  {
    name: '016_add_network_mode_setting',
    sql: `
      INSERT INTO settings (key, value) VALUES ('network_mode', 'direct') ON CONFLICT DO NOTHING;
    `,
  },
  {
    name: '017_add_paused_to_apps',
    sql: `
      ALTER TABLE apps ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT false;
      ALTER TABLE apps ADD COLUMN IF NOT EXISTS paused_redirect_url TEXT;
    `,
  },
  {
    name: '018_add_staging_subdomain_to_apps',
    sql: `
      ALTER TABLE apps ADD COLUMN IF NOT EXISTS staging_subdomain TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_staging_subdomain
        ON apps(staging_subdomain) WHERE staging_subdomain IS NOT NULL;
    `,
  },
  {
    name: '019_add_staging_root_domain_setting',
    sql: `
      INSERT INTO settings (key, value) VALUES ('staging_root_domain', '') ON CONFLICT DO NOTHING;
    `,
  },
];

async function migrate() {
  // Ensure tracking table exists first
  await db.query(`
    CREATE TABLE IF NOT EXISTS beachhead_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const { rows: applied } = await db.query('SELECT name FROM beachhead_migrations');
  const appliedSet = new Set(applied.map((r) => r.name));

  for (const migration of MIGRATIONS) {
    if (appliedSet.has(migration.name)) {
      logger.info(`Migration ${migration.name} already applied, skipping`);
      continue;
    }

    logger.info(`Applying migration: ${migration.name}`);
    await db.query(migration.sql);
    await db.query('INSERT INTO beachhead_migrations (name) VALUES ($1)', [migration.name]);
    logger.info(`Migration ${migration.name} applied successfully`);
  }

  logger.info('All migrations complete');
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Migration failed', err);
      process.exit(1);
    });
}

module.exports = { migrate };
