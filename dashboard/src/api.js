const BASE = '/api';

async function request(path, options = {}) {
  const token = localStorage.getItem('beachhead_token');
  const headers = { ...options.headers };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => null);

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
  getDeployments: (id) => request(`/apps/${id}/deployments`),
  getDeployment: (appId, deployId) => request(`/apps/${appId}/deployments/${deployId}`),
  getEnvVars: (appId) => request(`/apps/${appId}/env`),
  setEnvVar: (appId, data) => request(`/apps/${appId}/env`, { method: 'POST', body: data }),
  deleteEnvVar: (appId, envId) => request(`/apps/${appId}/env/${envId}`, { method: 'DELETE' }),
  getEnvFiles: (appId) => request(`/apps/${appId}/env-files`),
  saveEnvFile: (appId, data) => request(`/apps/${appId}/env-files`, { method: 'POST', body: data }),
  deleteEnvFile: (appId, fileId) => request(`/apps/${appId}/env-files/${fileId}`, { method: 'DELETE' }),
  getHealth: () => request('/health'),
  configureAuth: (data) => request('/bootstrap/configure-auth', { method: 'POST', body: data }),
  activateAuth: () => request('/bootstrap/activate-auth', { method: 'POST', body: {} }),
  getBootstrapStatus: () => request('/bootstrap/status'),
};
