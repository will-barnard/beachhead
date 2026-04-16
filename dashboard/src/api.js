const BASE = '/api';

async function request(path, options = {}) {
  const headers = { ...options.headers };

  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => null);

  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error(data?.error || 'Authentication required');
  }

  if (!res.ok) {
    throw new Error(data?.error || `Request failed: ${res.status}`);
  }
  return data;
}

export default {
  getApps: () => request('/apps'),
  getApp: (id) => request(`/apps/${id}`),
  createApp: (app) => request('/apps', { method: 'POST', body: app }),
  updateApp: (id, app) => request(`/apps/${id}`, { method: 'PUT', body: app }),
  deleteApp: (id) => request(`/apps/${id}`, { method: 'DELETE' }),
  deploy: (id, data) => request(`/apps/${id}/deploy`, { method: 'POST', body: data || {} }),
  cancelDeployment: (id) => request(`/apps/${id}/cancel-deployment`, { method: 'POST', body: {} }),
  enableWwwRedirect: (id) => request(`/apps/${id}/www`, { method: 'POST', body: {} }),
  getEndpoints: (appId) => request(`/apps/${appId}/endpoints`),
  addEndpoint: (appId, data) => request(`/apps/${appId}/endpoints`, { method: 'POST', body: data }),
  deleteEndpoint: (appId, endpointId) => request(`/apps/${appId}/endpoints/${endpointId}`, { method: 'DELETE' }),
  enableEndpointWww: (appId, endpointId) => request(`/apps/${appId}/endpoints/${endpointId}/www`, { method: 'POST', body: {} }),
  getDeployments: (id) => request(`/apps/${id}/deployments`),
  getDeployment: (appId, deployId) => request(`/apps/${appId}/deployments/${deployId}`),
  rollbackDeployment: (appId, deployId) => request(`/apps/${appId}/deployments/${deployId}/rollback`, { method: 'POST', body: {} }),
  getEnvVars: (appId) => request(`/apps/${appId}/env`),
  setEnvVar: (appId, data) => request(`/apps/${appId}/env`, { method: 'POST', body: data }),
  deleteEnvVar: (appId, envId) => request(`/apps/${appId}/env/${envId}`, { method: 'DELETE' }),
  getEnvFiles: (appId) => request(`/apps/${appId}/env-files`),
  saveEnvFile: (appId, data) => request(`/apps/${appId}/env-files`, { method: 'POST', body: data }),
  deleteEnvFile: (appId, fileId) => request(`/apps/${appId}/env-files/${fileId}`, { method: 'DELETE' }),
  getHealth: () => request('/health'),

  // Auth
  getBootstrapStatus: () => request('/bootstrap/status'),
  setupAdmin: (data) => request('/bootstrap/setup', { method: 'POST', body: data }),
  login: (data) => request('/bootstrap/login', { method: 'POST', body: data }),
  logout: () => request('/bootstrap/logout', { method: 'POST', body: {} }),
  getUsers: () => request('/bootstrap/users'),
  createUser: (data) => request('/bootstrap/users', { method: 'POST', body: data }),
  deleteUser: (id) => request(`/bootstrap/users/${id}`, { method: 'DELETE' }),
  generateWorkerToken: (userId) => request('/bootstrap/worker-token', { method: 'POST', body: { user_id: userId } }),

  // Settings
  getSettings: () => request('/bootstrap/settings'),
  updateSettings: (data) => request('/bootstrap/settings', { method: 'PUT', body: data }),

  // Static sites
  getStaticSites: () => request('/static-sites'),
  getStaticSite: (id) => request(`/static-sites/${id}`),
  createStaticSite: (data) => request('/static-sites', { method: 'POST', body: data }),
  deleteStaticSite: (id) => request(`/static-sites/${id}`, { method: 'DELETE' }),
  deployStaticSite: (id) => request(`/static-sites/${id}/deploy`, { method: 'POST', body: {} }),
  enableStaticSiteWww: (id) => request(`/static-sites/${id}/www`, { method: 'POST', body: {} }),

  // System
  getContainers: () => request('/system/containers'),
  stopContainer: (id) => request(`/system/containers/${id}/stop`, { method: 'POST', body: {} }),
  removeContainer: (id) => request(`/system/containers/${id}/remove`, { method: 'POST', body: {} }),
  systemPrune: (keep) => request('/system/prune', { method: 'POST', body: { keep } }),
  pruneApp: (appId, keep) => request(`/system/apps/${appId}/prune`, { method: 'POST', body: { keep } }),

  async uploadStaticSite(id, file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${BASE}/static-sites/${id}/upload`, { method: 'POST', body: formData });
    const data = await res.json().catch(() => null);
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error(data?.error || 'Authentication required');
    }
    if (!res.ok) throw new Error(data?.error || `Upload failed: ${res.status}`);
    return data;
  },
};
