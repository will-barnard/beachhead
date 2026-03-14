const https = require('https');
const http = require('http');
const config = require('../config');
const logger = require('../logger');

/**
 * Perform a health check on a deployed service.
 * Since the worker runs inside the beachhead-net Docker network alongside
 * nginx-proxy, we check HTTP (the proxy handles SSL termination externally).
 * Sends the Host header so nginx-proxy routes to the correct service.
 */
async function checkHealth(domain, { timeout, interval } = {}) {
  const totalTimeout = timeout || config.healthCheck.timeout;
  const checkInterval = interval || config.healthCheck.interval;
  const start = Date.now();

  while (Date.now() - start < totalTimeout) {
    try {
      const healthy = await httpGet(`http://beachhead-proxy`, 5000, domain);
      if (healthy) {
        logger.info(`Health check passed for ${domain}`);
        return true;
      }
    } catch {
      // retry
    }
    await sleep(checkInterval);
  }

  logger.warn(`Health check timed out for ${domain} after ${totalTimeout}ms`);
  return false;
}

function httpGet(url, timeoutMs, hostHeader) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const options = { timeout: timeoutMs };
    if (hostHeader) {
      options.headers = { Host: hostHeader };
    }
    const req = mod.get(url, options, (res) => {
      // Any 2xx or 3xx is considered healthy
      resolve(res.statusCode >= 200 && res.statusCode < 400);
      res.resume(); // consume response data to free memory
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { checkHealth };
