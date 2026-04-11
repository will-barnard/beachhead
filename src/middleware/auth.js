const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../logger');

/**
 * Bootstrap mode: no users exist yet, so all requests are allowed.
 * Once the first admin account is created, auth is required.
 */
let _userCount = null;

async function refreshUserCount() {
  try {
    const Users = require('../models/users');
    _userCount = await Users.count();
  } catch {
    _userCount = 0;
  }
}

function isBootstrapMode() {
  return _userCount === null || _userCount === 0;
}

function getSecret() {
  return config.auth.jwtSecret;
}

function signToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, getSecret(), { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

/**
 * Middleware: require authentication.
 * In bootstrap mode (no users), all requests pass through.
 * Once an admin account exists, a valid JWT is required.
 */
function requireAuth(req, res, next) {
  if (isBootstrapMode()) {
    req.user = { role: 'admin', bootstrap: true };
    return next();
  }

  let token;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies && req.cookies[config.auth.cookieName]) {
    token = req.cookies[config.auth.cookieName];
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    logger.warn('JWT verification failed', { error: err.message });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Middleware: require admin role.
 * Must be used after requireAuth.
 */
function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }

  next();
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  isBootstrapMode,
  signToken,
  refreshUserCount,
};
