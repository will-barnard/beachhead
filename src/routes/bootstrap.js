const express = require('express');
const config = require('../config');
const logger = require('../logger');
const Users = require('../models/users');
const Settings = require('../models/settings');
const { isBootstrapMode, signToken, refreshUserCount, requireAuth, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/bootstrap/setup
 * Create the initial admin account. Only works when no users exist (bootstrap mode).
 */
router.post('/setup', async (req, res) => {
  if (!isBootstrapMode()) {
    return res.status(403).json({ error: 'An admin account already exists' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const user = await Users.create({ username, password, role: 'admin' });
    await refreshUserCount();

    const token = signToken({ id: user.id, username: user.username, role: user.role });

    logger.info(`Bootstrap: admin account created — "${user.username}"`);

    res.cookie(config.auth.cookieName, token, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });

    res.status(201).json({ message: 'Admin account created', user: { id: user.id, username: user.username, role: user.role }, token });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    logger.error(`Bootstrap setup failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bootstrap/login
 * Authenticate with username/password and receive a JWT.
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const user = await Users.findByUsername(username);
    if (!user || !(await Users.verifyPassword(user, password))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = signToken({ id: user.id, username: user.username, role: user.role });

    res.cookie(config.auth.cookieName, token, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.json({ message: 'Logged in', user: { id: user.id, username: user.username, role: user.role }, token });
  } catch (err) {
    logger.error(`Login failed: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/bootstrap/logout
 * Clear the auth cookie.
 */
router.post('/logout', (req, res) => {
  res.clearCookie(config.auth.cookieName, { path: '/' });
  res.json({ message: 'Logged out' });
});

/**
 * GET /api/bootstrap/status
 * Returns auth state: bootstrap or authenticated, plus current user if logged in.
 */
router.get('/status', async (req, res) => {
  const bootstrap = isBootstrapMode();

  // Try to decode user from cookie/header if present
  let currentUser = null;
  if (!bootstrap) {
    let token;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (req.cookies && req.cookies[config.auth.cookieName]) {
      token = req.cookies[config.auth.cookieName];
    }
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, config.auth.jwtSecret);
        currentUser = { id: decoded.id, username: decoded.username, role: decoded.role };
      } catch {
        // expired or invalid — not an error for the status endpoint
      }
    }
  }

  res.json({ bootstrap, user: currentUser });
});

/**
 * GET /api/bootstrap/users
 * List all users (admin only).
 */
router.get('/users', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const users = await Users.findAll();
    res.json(users);
  } catch (err) {
    logger.error('Failed to list users', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/bootstrap/users
 * Create a new user (admin only).
 */
router.post('/users', requireAuth, requireSuperAdmin, async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const user = await Users.create({ username, password, role: role || 'admin' });
    await refreshUserCount();
    logger.info(`User created: "${user.username}" (by ${req.user.username || 'bootstrap'})`);
    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    logger.error(`User creation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/bootstrap/users/:id
 * Delete a user (admin only, cannot delete yourself).
 */
router.delete('/users/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  try {
    const deleted = await Users.delete(userId);
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    await refreshUserCount();
    logger.info(`User deleted: "${deleted.username}" (by ${req.user.username})`);
    res.json({ message: 'User deleted', user: deleted });
  } catch (err) {
    logger.error(`User deletion failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Settings ──

/**
 * GET /api/bootstrap/settings
 * Get all settings (admin only).
 */
router.get('/settings', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const settings = await Settings.getAll();
    // Never expose registry password in full
    if (settings.registry_password) {
      settings.registry_password = settings.registry_password ? '••••••••' : '';
    }
    if (settings.ghcr_token) {
      settings.ghcr_token = settings.ghcr_token ? '••••••••' : '';
    }
    res.json(settings);
  } catch (err) {
    logger.error('Failed to get settings', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/bootstrap/worker-token
 * Generate a long-lived token (1 year) for a user, intended for build workers.
 * Body: { user_id }
 */
router.post('/worker-token', requireAuth, requireSuperAdmin, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  try {
    const user = await Users.findById(user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const token = signToken({ id: user.id, username: user.username, role: user.role }, '365d');
    res.json({ token, expires_in: '365 days', username: user.username });
  } catch (err) {
    logger.error(`Worker token generation failed: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/bootstrap/settings
 * Update settings (admin only). Accepts { key: value } pairs.
 */
router.put('/settings', requireAuth, requireSuperAdmin, async (req, res) => {
  const allowed = ['build_mode', 'registry_type', 'registry_url', 'registry_user', 'registry_password', 'ghcr_owner', 'ghcr_token', 'git_ssh_key_path'];
  const updates = req.body;

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  try {
    for (const [key, value] of Object.entries(updates)) {
      if (!allowed.includes(key)) continue;
      if (key === 'build_mode' && !['local', 'remote'].includes(value)) {
        return res.status(400).json({ error: 'build_mode must be "local" or "remote"' });
      }
      if (key === 'registry_type' && !['generic', 'ghcr'].includes(value)) {
        return res.status(400).json({ error: 'registry_type must be "generic" or "ghcr"' });
      }
      // Skip masked password — don't overwrite with placeholder
      if (key === 'registry_password' && value === '••••••••') continue;
      if (key === 'ghcr_token' && value === '••••••••') continue;
      await Settings.set(key, String(value));
    }
    logger.info(`Settings updated by ${req.user.username || 'bootstrap'}`);
    const settings = await Settings.getAll();
    if (settings.registry_password) settings.registry_password = '••••••••';
    if (settings.ghcr_token) settings.ghcr_token = '••••••••';
    res.json(settings);
  } catch (err) {
    logger.error(`Settings update failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
