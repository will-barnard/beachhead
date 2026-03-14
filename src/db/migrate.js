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
