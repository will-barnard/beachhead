const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const config = require('../config');
const logger = require('../logger');

/**
 * Generate beachhead.override.yml for a deployed app.
 * This adds proxy environment variables to the public service
 * and connects it to the beachhead-net Docker network.
 */
function generateOverride({ appSlug, publicService, domain, publicPort, envVars }) {
  if (!publicService || !domain) {
    throw new Error('publicService and domain are required for compose override');
  }

  const port = publicPort || 80;

  // Slugify app name for use in container names — lowercase alphanum + dash
  const slug = (appSlug || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';

  const override = {
    services: {
      [publicService]: {
        container_name: `${slug}-${publicService}`,
        environment: [
          `VIRTUAL_HOST=${domain}`,
          `VIRTUAL_PORT=${port}`,
          `LETSENCRYPT_HOST=${domain}`,
        ],
        networks: ['beachhead-net'],
      },
    },
    networks: {
      'beachhead-net': {
        external: true,
      },
    },
  };

  // Inject additional env vars targeted at each service
  if (envVars && envVars.length > 0) {
    // Group env vars by target service
    const serviceEnvs = {};
    for (const ev of envVars) {
      const target = ev.target_service || publicService;
      if (!serviceEnvs[target]) serviceEnvs[target] = [];
      serviceEnvs[target].push(`${ev.key}=${ev.value}`);
    }

    for (const [service, vars] of Object.entries(serviceEnvs)) {
      if (!override.services[service]) {
        override.services[service] = {
          container_name: `${slug}-${service}`,
          environment: [],
        };
      }
      if (!override.services[service].environment) {
        override.services[service].environment = [];
      }
      override.services[service].environment.push(...vars);
    }
  }

  return yaml.dump(override, { lineWidth: -1 });
}

/**
 * Write the override file to the deployment directory.
 */
function writeOverrideFile(deployDir, overrideContent) {
  const overridePath = path.join(deployDir, 'beachhead.override.yml');
  fs.writeFileSync(overridePath, overrideContent, 'utf8');
  logger.info(`Wrote compose override: ${overridePath}`);
  return overridePath;
}

/**
 * Read beachhead.json from a repo if it exists.
 * Returns metadata for the app (public_service, public_port, health_check).
 */
function readBeachheadConfig(deployDir) {
  const configPath = path.join(deployDir, 'beachhead.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`Failed to parse beachhead.json: ${err.message}`);
    return null;
  }
}

module.exports = {
  generateOverride,
  writeOverrideFile,
  readBeachheadConfig,
};
