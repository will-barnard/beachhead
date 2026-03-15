const { Router, raw: expressRaw } = require('express');
const crypto = require('crypto');
const Apps = require('../models/apps');
const Deployments = require('../models/deployments');
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

    // Find matching apps
    const apps = await Apps.findByRepoUrl(normalizedUrl);
    if (apps.length === 0) {
      // Also try with .git suffix
      const appsAlt = await Apps.findByRepoUrl(normalizedUrl + '.git');
      if (appsAlt.length === 0) {
        logger.warn(`Webhook: no app registered for repo: ${normalizedUrl}`);
        return res.status(404).json({ error: 'No app registered for this repository' });
      }
      apps.push(...appsAlt);
    }

    logger.info(`Webhook: found ${apps.length} app(s) matching repo ${normalizedUrl}: ${apps.map(a => a.name).join(', ')}`);

    const deploymentsCreated = [];

    for (const app of apps) {
      // Check branch match
      const expectedRef = `refs/heads/${app.branch}`;
      if (ref !== expectedRef) {
        logger.info(`Webhook: skipping ${app.name} — push ref '${ref}' does not match expected '${expectedRef}'`);
        continue;
      }

      // Verify webhook signature
      const secret = app.webhook_secret || config.github.webhookSecret;
      if (secret) {
        if (!verifyGitHubSignature(secret, rawBody, signature)) {
          logger.warn(`Webhook: invalid signature for app '${app.name}' — check webhook secret matches GitHub`);
          continue;
        }
        logger.info(`Webhook: signature verified for ${app.name}`);
      } else {
        logger.warn(`Webhook: no secret configured for ${app.name} — skipping signature check`);
      }

      // Check auto_deploy
      if (!app.auto_deploy) {
        logger.info(`Webhook: auto-deploy disabled for ${app.name}, skipping`);
        continue;
      }

      // Create deployment
      const deployment = await Deployments.create({
        app_id: app.id,
        commit_hash: commitHash,
      });

      logger.info(`Webhook: deployment #${deployment.id} created for ${app.name} (commit ${commitHash})`);
      deploymentsCreated.push(deployment);
    }

    logger.info(`Webhook: done — created ${deploymentsCreated.length} deployment(s)`);
    res.status(200).json({
      message: `Created ${deploymentsCreated.length} deployment(s)`,
      deployments: deploymentsCreated,
    });
  } catch (err) {
    logger.error('Webhook processing failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
