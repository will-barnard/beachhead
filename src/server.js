const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./logger');
const { migrate } = require('./db/migrate');
const worker = require('./services/worker');

// Routes
const appsRouter = require('./routes/apps');
const envVarsRouter = require('./routes/envVars');
const envFilesRouter = require('./routes/envFiles');
const webhooksRouter = require('./routes/webhooks');
const bootstrapRouter = require('./routes/bootstrap');

const app = express();

// Trust the nginx-proxy reverse proxy so express-rate-limit can identify
// real client IPs from the X-Forwarded-For header.
app.set('trust proxy', 1);

// Security
app.use(helmet());

// CORS — in production lock to BEACHHEAD_DOMAIN; in development allow all
const corsOptions = config.nodeEnv === 'production' && config.domain
  ? { origin: [`https://${config.domain}`, `http://${config.domain}`] }
  : {};
app.use(cors(corsOptions));

// Rate limiting
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// Body parsing (webhooks use raw body, everything else uses JSON)
// Note: webhook route handles its own body parsing via express.raw()
app.use('/api/webhooks', webhookLimiter, webhooksRouter);

app.use(cookieParser());
app.use(express.json());
app.use('/api', apiLimiter);

// API routes
app.use('/api/apps', appsRouter);
app.use('/api/apps', envVarsRouter);
app.use('/api/apps', envFilesRouter);
app.use('/api/bootstrap', bootstrapRouter);

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mode: require('./middleware/auth').isBootstrapMode() ? 'bootstrap' : 'authenticated' });
});

// Status endpoint
app.get('/api/status', async (req, res) => {
  try {
    const db = require('./db');
    await db.query('SELECT 1');
    res.json({ db: 'connected', worker: 'running' });
  } catch {
    res.status(503).json({ db: 'disconnected' });
  }
});

// 404 handler for unmatched /api routes — must come before static/SPA fallback
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
});

// Serve dashboard static files in production
const path = require('path');
const dashboardPath = path.join(__dirname, '..', 'dashboard', 'dist');
const fs = require('fs');
if (fs.existsSync(dashboardPath)) {
  app.use(express.static(dashboardPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(dashboardPath, 'index.html'));
  });
}

async function start() {
  try {
    // Run migrations
    await migrate();
    logger.info('Database migrations complete');

    // Start deployment worker
    worker.start();

    // Start HTTP server
    app.listen(config.port, () => {
      logger.info(`Beachhead server running on port ${config.port}`);
      logger.info(`Mode: ${require('./middleware/auth').isBootstrapMode() ? 'BOOTSTRAP (no auth)' : 'AUTHENTICATED'}`);
    });
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  worker.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  worker.stop();
  process.exit(0);
});

start();

module.exports = app;
