const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const config = require('../config');
const logger = require('../logger');

let jwksClient = null;

function getJwksClient() {
  if (!jwksClient && config.auth.jwksUrl) {
    jwksClient = jwksRsa({
      jwksUri: config.auth.jwksUrl,
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }
  return jwksClient;
}

function isBootstrapMode() {
  return !config.auth.jwksUrl;
}

function getSigningKey(header, callback) {
  const client = getJwksClient();
  if (!client) {
    return callback(new Error('JWKS client not configured'));
  }
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getSigningKey,
      {
        algorithms: ['RS256'],
        issuer: config.auth.issuer || undefined,
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      }
    );
  });
}

/**
 * Middleware: require authentication.
 * In bootstrap mode (no AUTH_JWKS_URL), all requests pass through.
 * Once auth service is configured, JWT Bearer token is required.
 */
function loginUrl() {
  return config.auth.issuer ? `${config.auth.issuer}/login` : null;
}

function requireAuth(req, res, next) {
  if (isBootstrapMode()) {
    req.user = { role: 'super_admin', bootstrap: true };
    return next();
  }

  // Accept token from Authorization header (API clients) or cookie (browser)
  let token;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies && req.cookies[config.auth.cookieName]) {
    token = req.cookies[config.auth.cookieName];
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required', loginUrl: loginUrl() });
  }

  verifyToken(token)
    .then((decoded) => {
      // If this Beachhead has a workspace configured, verify user has access
      const wsId = config.auth.workspaceId;
      if (wsId && decoded.workspaces) {
        const membership = decoded.workspaces.find((w) => w.id === wsId || w.slug === config.auth.workspaceSlug);
        if (!membership && decoded.role !== 'super_admin') {
          return res.status(403).json({
            error: 'You do not have access to this workspace',
            loginUrl: loginUrl(),
          });
        }
        // Attach workspace-specific role if found
        if (membership) {
          decoded.workspaceRole = membership.role;
        }
      }
      req.user = decoded;
      next();
    })
    .catch((err) => {
      logger.warn('JWT verification failed', { error: err.message });
      res.status(401).json({ error: 'Invalid or expired token', loginUrl: loginUrl() });
    });
}

/**
 * Middleware: require super_admin role.
 * Must be used after requireAuth.
 */
function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'super_admin role required' });
  }

  next();
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  isBootstrapMode,
};
