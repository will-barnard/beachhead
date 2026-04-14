const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const config = require('../config');
const logger = require('../logger');

/**
 * Generate beachhead.override.yml for a deployed app.
 * This adds proxy environment variables to the public service(s)
 * and connects them to the beachhead-net Docker network.
 *
 * additionalEndpoints: optional array of { service, domain, port, wwwRedirect }
 * for apps with multiple public-facing services on different subdomains.
 */
function generateOverride({ appSlug, deployId, publicService, domain, publicPort, envVars, namedVolumes, wwwRedirect, statefulNetwork, additionalEndpoints, imageOverrides }) {
  if (!publicService || !domain) {
    throw new Error('publicService and domain are required for compose override');
  }

  const port = publicPort || 80;

  // Slugify app name for use in container names — lowercase alphanum + dash
  const slug = (appSlug || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  // Include deployment ID so each deploy has unique container names (avoids name conflicts
  // when old containers are still running during the new deploy's startup phase).
  const suffix = deployId ? `-d${deployId}` : '';

  const networksSection = {
    'beachhead-net': {
      external: true,
    },
  };
  // When stateful services are present, give the internal network a fixed name so
  // stateful containers (different compose project) and transient containers share
  // the same underlying Docker network and can reach each other by hostname.
  if (statefulNetwork) {
    networksSection.internal = {
      external: true,
      name: statefulNetwork,
    };
  }

  const primaryHosts = wwwRedirect ? `${domain},www.${domain}` : domain;

  const override = {
    services: {
      [publicService]: {
        container_name: `${slug}-${publicService}${suffix}`,
        restart: 'unless-stopped',
        environment: [
          `VIRTUAL_HOST=${primaryHosts}`,
          `VIRTUAL_PORT=${port}`,
          `LETSENCRYPT_HOST=${primaryHosts}`,
        ],
        networks: ['beachhead-net'],
      },
    },
    networks: networksSection,
  };

  // Additional public endpoints (each gets its own VIRTUAL_HOST/LETSENCRYPT_HOST)
  if (additionalEndpoints && additionalEndpoints.length > 0) {
    for (const ep of additionalEndpoints) {
      const epHosts = ep.wwwRedirect ? `${ep.domain},www.${ep.domain}` : ep.domain;
      const epPort = ep.port || 80;

      if (override.services[ep.service]) {
        // Service already exists (e.g. from primary) — comma-append additional domains
        // to the existing VIRTUAL_HOST/LETSENCRYPT_HOST entries so nginx-proxy sees a
        // single comma-separated value rather than duplicate keys (last-one-wins).
        const env = override.services[ep.service].environment;
        const vhIdx = env.findIndex(e => e.startsWith('VIRTUAL_HOST='));
        const leIdx = env.findIndex(e => e.startsWith('LETSENCRYPT_HOST='));
        if (vhIdx !== -1) {
          env[vhIdx] = `${env[vhIdx]},${epHosts}`;
        } else {
          env.push(`VIRTUAL_HOST=${epHosts}`);
        }
        if (leIdx !== -1) {
          env[leIdx] = `${env[leIdx]},${epHosts}`;
        } else {
          env.push(`LETSENCRYPT_HOST=${epHosts}`);
        }
        if (!override.services[ep.service].networks.includes('beachhead-net')) {
          override.services[ep.service].networks.push('beachhead-net');
        }
      } else {
        override.services[ep.service] = {
          container_name: `${slug}-${ep.service}${suffix}`,
          restart: 'unless-stopped',
          environment: [
            `VIRTUAL_HOST=${epHosts}`,
            `VIRTUAL_PORT=${epPort}`,
            `LETSENCRYPT_HOST=${epHosts}`,
          ],
          networks: ['beachhead-net'],
        };
      }
    }
  }

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

  // Inject prebuilt image references from remote build workers.
  // When present, each service uses the registry image instead of building locally.
  if (imageOverrides && Object.keys(imageOverrides).length > 0) {
    for (const [service, imageTag] of Object.entries(imageOverrides)) {
      if (!override.services[service]) {
        override.services[service] = {
          container_name: `${slug}-${service}${suffix}`,
          restart: 'unless-stopped',
        };
      }
      override.services[service].image = imageTag;
      override.services[service].pull_policy = 'always';
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
 * Read the resolved Docker volume names used by specific services.
 * Returns an array of name strings (from the `name:` key in the top-level volumes section).
 * Used to detect volume conflicts before migrating a service to the stateful project.
 */
function readServiceVolumes(deployDir, serviceNames) {
  const composePath = path.join(deployDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return [];

  try {
    const raw = fs.readFileSync(composePath, 'utf8');
    const doc = yaml.load(raw);
    if (!doc) return [];

    const topLevelVolumes = doc.volumes || {};
    const result = [];

    for (const serviceName of serviceNames) {
      const service = doc.services?.[serviceName];
      if (!service?.volumes) continue;

      for (const vol of service.volumes) {
        // vol can be a string like "postgres-data:/var/run/..." or an object with .source
        const volKey = typeof vol === 'string' ? vol.split(':')[0] : vol?.source;
        if (!volKey) continue;
        const volConfig = topLevelVolumes[volKey];
        if (volConfig?.name) {
          result.push(volConfig.name);
        }
      }
    }

    return [...new Set(result)];
  } catch (err) {
    logger.warn(`Failed to read service volumes: ${err.message}`);
    return [];
  }
}

/**
 * Generate a minimal compose override that gives the `internal` network a fixed
 * external name, and marks explicitly-named volumes as external. Used when starting
 * stateful services so they join the same Docker network as the transient services
 * in the per-deploy project, and so Docker Compose doesn't fight over volume ownership.
 */
function generateStatefulOverride(statefulNetwork, namedVolumes = []) {
  const doc = {
    networks: {
      internal: {
        external: true,
        name: statefulNetwork,
      },
    },
  };

  if (namedVolumes.length > 0) {
    doc.volumes = {};
    for (const vol of namedVolumes) {
      doc.volumes[vol.key] = { name: vol.name, external: true };
    }
  }

  return yaml.dump(doc, { lineWidth: -1 });
}

/**
 * Read all service names from a docker-compose.yml.
 * Returns an array of service name strings.
 */
function readAllServiceNames(deployDir) {
  const composePath = path.join(deployDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return [];

  try {
    const raw = fs.readFileSync(composePath, 'utf8');
    const doc = yaml.load(raw);
    if (!doc || !doc.services) return [];
    return Object.keys(doc.services);
  } catch (err) {
    logger.warn(`Failed to read service names from docker-compose.yml: ${err.message}`);
    return [];
  }
}

/**
 * Read beachhead.json from a repo if it exists.
 * Returns metadata for the app (public_service, public_port, health_check, stateful_services).
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

/**
 * Read all services that have a `build:` directive in docker-compose.yml.
 * Returns an array of { service, dockerfile, context } objects.
 * Used to determine which images the remote build worker needs to produce.
 */
function readBuildableServices(deployDir) {
  const composePath = path.join(deployDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return [];

  try {
    const raw = fs.readFileSync(composePath, 'utf8');
    const doc = yaml.load(raw);
    if (!doc || !doc.services) return [];

    const result = [];
    for (const [name, svc] of Object.entries(doc.services)) {
      if (!svc.build) continue;

      if (typeof svc.build === 'string') {
        // Short syntax: build: ./path
        result.push({ service: name, dockerfile: 'Dockerfile', context: svc.build });
      } else {
        // Object syntax: build: { context: ..., dockerfile: ... }
        result.push({
          service: name,
          dockerfile: svc.build.dockerfile || 'Dockerfile',
          context: svc.build.context || '.',
        });
      }
    }
    return result;
  } catch (err) {
    logger.warn(`Failed to read buildable services: ${err.message}`);
    return [];
  }
}

module.exports = {
  generateOverride,
  writeOverrideFile,
  readBeachheadConfig,
  readNamedVolumes,
  readAllServiceNames,
  readServiceVolumes,
  readBuildableServices,
  generateStatefulOverride,
};
