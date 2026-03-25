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
function generateOverride({ appSlug, deployId, publicService, domain, publicPort, envVars, namedVolumes, wwwRedirect }) {
  if (!publicService || !domain) {
    throw new Error('publicService and domain are required for compose override');
  }

  const port = publicPort || 80;

  // Slugify app name for use in container names — lowercase alphanum + dash
  const slug = (appSlug || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  // Include deployment ID so each deploy has unique container names (avoids name conflicts
  // when old containers are still running during the new deploy's startup phase).
  const suffix = deployId ? `-d${deployId}` : '';

  const override = {
    services: {
      [publicService]: {
        container_name: `${slug}-${publicService}${suffix}`,
        restart: 'unless-stopped',
        environment: [
          `VIRTUAL_HOST=${wwwRedirect ? `${domain},www.${domain}` : domain}`,
          `VIRTUAL_PORT=${port}`,
          `LETSENCRYPT_HOST=${wwwRedirect ? `${domain},www.${domain}` : domain}`,
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

  // Mark any explicitly named volumes as external so Docker Compose doesn't
  // try to manage them per-project (which causes warnings/conflicts across deploys).
  if (namedVolumes && namedVolumes.length > 0) {
    override.volumes = {};
    for (const vol of namedVolumes) {
      override.volumes[vol.key] = { name: vol.name, external: true };
    }
  }

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
          container_name: `${slug}-${service}${suffix}`,
          restart: 'unless-stopped',
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
 * Read named volumes from a docker-compose.yml.
 * Returns an array of { key, name } for volumes with an explicit `name:`.
 */
function readNamedVolumes(deployDir) {
  const composePath = path.join(deployDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return [];

  try {
    const raw = fs.readFileSync(composePath, 'utf8');
    const doc = yaml.load(raw);
    if (!doc || !doc.volumes) return [];

    const result = [];
    for (const [key, volConfig] of Object.entries(doc.volumes)) {
      if (volConfig && typeof volConfig === 'object' && volConfig.name) {
        result.push({ key, name: volConfig.name });
      }
    }
    return result;
  } catch (err) {
    logger.warn(`Failed to read volumes from docker-compose.yml: ${err.message}`);
    return [];
  }
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
  readNamedVolumes,
};
