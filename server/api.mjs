import { ApiError } from './database.mjs';

function send(response, status, body) { // Keeps every authenticated response out of browser, proxy, and service-worker caches.
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Cookie' });
  response.end(JSON.stringify(body));
}

async function body(request) { // Bounds uploads before parsing and rejects content types that could be submitted by an ordinary cross-site form.
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new ApiError(415, 'Send application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new ApiError(413, 'Sync request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON.'); }
}

export function createApi(database, login) { // Resolves each app session to an OIDC identity and isolates all data by that identity.
  return async (request, response, route) => {
    try {
      const origin = request.headers.origin;
      if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== login.origin)) throw new ApiError(403, 'This origin is not allowed.');
      if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'Method not allowed.');
      const session = login.session(request);
      if (!session) throw new ApiError(401, 'Sign in with your shared account to sync.');
      const { participant, csrf } = session;
      if (request.method === 'POST' && (origin !== login.origin || request.headers['x-csrf-token'] !== csrf)) throw new ApiError(403, 'Refresh your session before saving.');
      if (route === 'growth-chart' && request.method === 'GET') return send(response, 200, { participant, csrf, ...database.growthChart(participant.id) });
      if (route === 'growth-chart' && request.method === 'POST') return send(response, 200, { participant, ...database.saveGrowthChart(participant.id, await body(request)) });
      if (route === 'session' && request.method === 'GET') return send(response, 200, { participant, csrf, records: database.records(participant.id) });
      if (route === 'logout' && request.method === 'POST') { login.logout(request, response); return send(response, 200, { ok: true }); }
      if (route === 'sync' && request.method === 'POST') {
        const input = await body(request);
        return send(response, 200, { participant, ...database.sync(participant.id, input?.changes) });
      }
      throw new ApiError(404, 'Endpoint not found.');
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response, error.status ?? 500, { error: error.status ? error.message : 'The database could not save this request. Your device will retry.' });
      if (!error.status) console.error('Database request failed:', error.code ?? error.name); // Never logs session credentials, request bodies, or personal records.
    }
  };
}
