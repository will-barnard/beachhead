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
async function checkHealth(domain, { timeout, interval, path: healthPath } = {}) {
  const totalTimeout = timeout || config.healthCheck.timeout;
  const checkInterval = interval || config.healthCheck.interval;
  const urlPath = healthPath || '/';
  const start = Date.now();
  let lastStatus = null;

  while (Date.now() - start < totalTimeout) {
    try {
      const status = await httpGetStatus(`http://beachhead-proxy${urlPath}`, 5000, domain);
      lastStatus = status;
      if (status >= 200 && status < 400) {
        logger.info(`Health check passed for ${domain}${urlPath} (${status})`);
        return true;
      }
      logger.debug(`Health check ${domain}${urlPath}: ${status}`);
    } catch (err) {
      logger.debug(`Health check ${domain}${urlPath}: ${err.message}`);
    }
    await sleep(checkInterval);
  }

  logger.warn(`Health check timed out for ${domain}${urlPath} after ${totalTimeout}ms (last status: ${lastStatus})`);
  return false;
}

function httpGetStatus(url, timeoutMs, hostHeader) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = { timeout: timeoutMs };
    if (hostHeader) {
      options.headers = { Host: hostHeader };
    }
    const req = mod.get(url, options, (res) => {
      resolve(res.statusCode);
      res.resume(); // consume response data to free memory
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { checkHealth };
