const { Router, raw: expressRaw } = require('express');
const crypto = require('crypto');
const Apps = require('../models/apps');
const StaticSites = require('../models/staticSites');
const Deployments = require('../models/deployments');
const siteRuntime = require('../services/staticSites');
const config = require('../config');
const logger = require('../logger');

const router = Router();

function verifyGitHubSignature(secret, payload, signature) {
  if (!secret || !signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual throws if lengths differ — short-circuit first
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Try a strict and a `.git`-suffixed lookup against the given finder. The
 * webhook payload's `repository.html_url` never includes `.git`, but a user
 * may have registered the repo with the suffix; mirror Apps.findByRepoUrl
 * dual-lookup behaviour.
 */
async function findByEitherSuffix(finder, repoUrl) {
  const exact = await finder(repoUrl);
  if (exact.length > 0) return exact;
  const withSuffix = await finder(repoUrl + '.git');
  return withSuffix;
}

// GitHub webhook endpoint — uses raw body for HMAC verification
router.post('/github', expressRaw({ type: 'application/json', limit: '10mb' }), async (req, res) => {
  try {
    const signature = req.headers['x-hub-signature-256'];
    const event = req.headers['x-github-event'];
    const rawBody = req.body;

    logger.info(`Webhook received: event=${event} signature=${signature ? 'present' : 'absent'}`);

    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      logger.warn('Webhook rejected: invalid payload (not a buffer)');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));

    // Only process push events
    if (event !== 'push') {
      logger.info(`Webhook ignored: event type is '${event}', not 'push'`);
      return res.status(200).json({ message: `Ignored event: ${event}` });
    }

    const repoUrl = payload.repository?.html_url || payload.repository?.clone_url;
    if (!repoUrl) {
      logger.warn('Webhook rejected: could not determine repository URL from payload');
      return res.status(400).json({ error: 'Could not determine repository URL' });
    }

    const ref = payload.ref || '';
    const commitHash = payload.after || payload.head_commit?.id || null;
    logger.info(`Webhook push: repo=${repoUrl} ref=${ref} commit=${commitHash}`);

    // Normalize URL: strip .git suffix and trailing slashes
    const normalizedUrl = repoUrl.replace(/\.git$/, '').replace(/\/+$/, '');

    // ── App matches ────────────────────────────────────────────────────
    const apps = await findByEitherSuffix(Apps.findByRepoUrl.bind(Apps), normalizedUrl);
    const sites = await findByEitherSuffix(StaticSites.findByRepoUrl.bind(StaticSites), normalizedUrl);

    if (apps.length === 0 && sites.length === 0) {
      logger.warn(`Webhook: no app or static site registered for repo: ${normalizedUrl}`);
      return res.status(404).json({ error: 'No app or static site registered for this repository' });
    }

    logger.info(
      `Webhook: matched ${apps.length} app(s) and ${sites.length} static site(s) for ${normalizedUrl}`
    );

    const deploymentsCreated = [];
    const staticDeploysQueued = [];

    // App deploys (existing behaviour, unchanged)
    for (const app of apps) {
      const expectedRef = `refs/heads/${app.branch}`;
      if (ref !== expectedRef) {
        logger.info(`Webhook: skipping app ${app.name} — ref '${ref}' does not match '${expectedRef}'`);
        continue;
      }

      const secret = app.webhook_secret || config.github.webhookSecret;
      if (secret) {
        if (!verifyGitHubSignature(secret, rawBody, signature)) {
          logger.warn(`Webhook: invalid signature for app '${app.name}'`);
          continue;
        }
        logger.info(`Webhook: signature verified for app ${app.name}`);
      } else {
        logger.warn(`Webhook: no secret configured for app ${app.name} — skipping signature check`);
      }

      if (app.paused) {
        logger.info(`Webhook: app ${app.name} is paused, skipping`);
        continue;
      }
      if (!app.auto_deploy) {
        logger.info(`Webhook: auto-deploy disabled for app ${app.name}, skipping`);
        continue;
      }

      const deployment = await Deployments.create({
        app_id: app.id,
        commit_hash: commitHash,
      });
      logger.info(`Webhook: app deployment #${deployment.id} created for ${app.name} (commit ${commitHash})`);
      deploymentsCreated.push(deployment);
    }

    // Static-site deploys
    for (const site of sites) {
      const expectedRef = `refs/heads/${site.branch || 'main'}`;
      if (ref !== expectedRef) {
        logger.info(`Webhook: skipping static site ${site.name} — ref '${ref}' does not match '${expectedRef}'`);
        continue;
      }

      const secret = site.webhook_secret || config.github.webhookSecret;
      if (secret) {
        if (!verifyGitHubSignature(secret, rawBody, signature)) {
          logger.warn(`Webhook: invalid signature for static site '${site.name}'`);
          continue;
        }
        logger.info(`Webhook: signature verified for static site ${site.name}`);
      } else {
        logger.warn(`Webhook: no secret configured for static site ${site.name} — skipping signature check`);
      }

      if (!site.auto_deploy) {
        logger.info(`Webhook: auto-deploy disabled for static site ${site.name}, skipping`);
        continue;
      }

      // Fire-and-forget — webhook responds immediately so GitHub doesn't time
      // out on long builds. Result is observable via GET /:id/logs.
      siteRuntime.deployFromGit(site, { commitHash, trigger: 'webhook' })
        .catch(err => logger.error(`Webhook static deploy failed for ${site.name}: ${err.message}`));
      staticDeploysQueued.push({ id: site.id, name: site.name });
      logger.info(`Webhook: static-site deploy queued for ${site.name} (commit ${commitHash})`);
    }

    logger.info(
      `Webhook: done — ${deploymentsCreated.length} app deployment(s), ${staticDeploysQueued.length} static deploy(s) queued`
    );
    res.status(200).json({
      message: `Created ${deploymentsCreated.length} app deployment(s) and queued ${staticDeploysQueued.length} static deploy(s)`,
      deployments: deploymentsCreated,
      static_deploys: staticDeploysQueued,
    });
  } catch (err) {
    logger.error('Webhook processing failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
