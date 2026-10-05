async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error(body?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.currentRevision = body?.currentRevision;
    throw err;
  }
  return body;
}

export const api = {
  event: () => request('/api/event'),
  results: () => request('/api/results'),
  setup: payload => request('/api/setup', { method: 'POST', body: JSON.stringify(payload) }),
  importPunches: payload =>
    request('/api/punches/import', { method: 'POST', body: JSON.stringify(payload) }),
  punches: bib => request(`/api/punches${bib ? `?bib=${encodeURIComponent(bib)}` : ''}`),
  voidPunch: (id, reason) =>
    request(`/api/punches/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) }),
  correctPunch: (id, payload) =>
    request(`/api/punches/${id}/correct`, { method: 'POST', body: JSON.stringify(payload) }),
  publications: () => request('/api/publications'),
  publication: v => request(`/api/publications/${v}`),
  publish: payload => request('/api/publications', { method: 'POST', body: JSON.stringify(payload) }),
  stoppages: () => request('/api/stoppages'),
  saveStoppages: payload =>
    request('/api/stoppages', { method: 'POST', body: JSON.stringify(payload) }),
  divisions: () => request('/api/divisions'),
  saveDivisions: payload =>
    request('/api/divisions', { method: 'POST', body: JSON.stringify(payload) }),
  appealPreview: payload =>
    request('/api/appeals/preview', { method: 'POST', body: JSON.stringify(payload) }),
  appealConfirm: payload =>
    request('/api/appeals/confirm', { method: 'POST', body: JSON.stringify(payload) }),
};
