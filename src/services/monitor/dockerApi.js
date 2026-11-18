const http = require('http');

/**
 * Minimal Docker Engine API client over the mounted socket.
 *
 * The rest of Beachhead shells out to the docker CLI, which is right for
 * compose. The monitor polls every container every minute and holds an events
 * stream open forever, so it talks to the API directly: no process spawn per
 * call, structured JSON instead of parsed text, and a single long-lived
 * connection for events. Zero dependencies on purpose.
 *
 * Honours DOCKER_HOST (unix:// or tcp://) the same way the CLI does, so a
 * colima or remote-daemon setup works without extra config.
 */

function connectionOptions() {
  const dh = process.env.DOCKER_HOST || '';
  if (dh.startsWith('tcp://')) {
    const u = new URL(dh.replace(/^tcp:/, 'http:'));
    return { host: u.hostname, port: Number(u.port) || 2375 };
  }
  if (dh.startsWith('unix://')) return { socketPath: dh.slice('unix://'.length) };
  return { socketPath: '/var/run/docker.sock' };
}

function request(method, path, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...connectionOptions(), method, path, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(`Docker API ${method} ${path} → ${res.statusCode}: ${body.slice(0, 300)}`);
          err.status = res.statusCode;
          return reject(err);
        }
        if (!body) return resolve(null);
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Docker API returned non-JSON for ${path}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker API ${path} timed out after ${timeout}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Open a streaming endpoint (newline-delimited JSON) and call onObject for
 * each message. Returns a handle with close(). onEnd fires when the stream
 * drops for any reason so the caller can reconnect.
 */
function stream(path, onObject, onEnd) {
  let buf = '';
  let ended = false;
  const finish = (err) => {
    if (ended) return;
    ended = true;
    onEnd && onEnd(err);
  };
  const req = http.request({ ...connectionOptions(), method: 'GET', path }, (res) => {
    if (res.statusCode >= 400) {
      res.resume();
      return finish(new Error(`Docker stream ${path} → ${res.statusCode}`));
    }
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onObject(JSON.parse(line)); } catch { /* skip a malformed line rather than drop the stream */ }
      }
    });
    res.on('end', () => finish());
    res.on('close', () => finish());
  });
  req.on('error', (err) => finish(err));
  req.end();
  return { close: () => { ended = true; req.destroy(); } };
}

module.exports = {
  info: () => request('GET', '/info'),
  listContainers: (all = true) => request('GET', `/containers/json?all=${all ? 1 : 0}`),
  inspect: (id) => request('GET', `/containers/${encodeURIComponent(id)}/json`),
  // one-shot=true returns immediately instead of waiting ~1s to fill
  // precpu_stats; the collector computes CPU% from its own previous sample.
  stats: (id) => request('GET', `/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=true`, { timeout: 10000 }),
  // /system/df walks every volume to size it — seconds on a busy host, so the
  // collector calls it on a slow cadence.
  systemDf: () => request('GET', '/system/df', { timeout: 120000 }),
  events: (filters, onObject, onEnd) =>
    stream(`/events?filters=${encodeURIComponent(JSON.stringify(filters))}`, onObject, onEnd),
};
