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
