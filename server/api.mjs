import {coinBrowserApi} from './coin-browser-api.mjs';
import {coinApi} from './coin-api.mjs';
import { ApiError } from './database.mjs';
import {reportApi} from './ai-report-access.mjs';
import {statisticsApi} from './statistics.mjs';

function send(response, status, body) { // Keeps every authenticated response out of browser, proxy, and service-worker caches.
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Cookie' });
  response.end(JSON.stringify(body));
}

async function body(request, limit = 256 * 1024) { // Bounds uploads before parsing and rejects content types that could be submitted by an ordinary cross-site form.
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new ApiError(415, 'Send application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'Sync request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON.'); }
}

export function createApi(database, login) { // Resolves each app session to an OIDC identity and isolates all data by that identity.
  return async (request, response, route) => {
    try {
      if(route.startsWith('statistics/v1/'))return statisticsApi(database,login,request,response,route.slice('statistics/v1/'.length));
      if(route.startsWith('ai-reports/v1/'))return reportApi(database,login,request,response,route.slice('ai-reports/v1/'.length));
      if(route.startsWith('lidollcoin/browser/'))return coinBrowserApi(database,login,request,response,route.slice('lidollcoin/browser/'.length));
      if(route.startsWith('lidollcoin/v1/'))return coinApi(database,login,request,response,route.slice('lidollcoin/v1/'.length));
      const origin = request.headers.origin;
      if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== login.origin)) throw new ApiError(403, 'This origin is not allowed.');
      if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'Method not allowed.');
      if (['reminder','margin-note'].includes(route) && request.method === 'GET') {
        const value=database.admin.reminder(route);
        return send(response,200,{text:value.enabled?value.text:'',enabled:value.enabled,version:value.version}); // Only the published notice is public; disabled drafts and editor metadata remain private.
      }
      const session = login.session(request);
      if (!session) throw new ApiError(401, 'Sign in with your shared account to sync.');
      const { participant, csrf } = session;
      if (request.method === 'POST' && (origin !== login.origin || request.headers['x-csrf-token'] !== csrf)) throw new ApiError(403, 'Refresh your session before saving.');
      if(route==='notifications'&&request.method==='GET')return send(response,200,{...database.notifications.status(participant.id),csrf,participant});
      if(route==='notifications'&&request.method==='POST')return send(response,200,database.notifications.save(participant.id,await body(request,8192)));
      if(route==='notifications/disable'&&request.method==='POST')return send(response,200,database.notifications.remove(participant.id,await body(request,4096)));
      if(route==='coin-connections'&&request.method==='GET')return send(response,200,{participant,csrf,connections:database.economy.coins('connections',participant.id)});
      if(route==='coin-inspect'&&request.method==='POST')return send(response,200,database.economy.coins('inspect',participant.id,(await body(request,4096)).user_code));
      if(route==='coin-approve'&&request.method==='POST')return send(response,200,database.economy.coins('approve',participant.id,await body(request,4096)));
      if(route==='coin-revoke'&&request.method==='POST')return send(response,200,database.economy.coins('revoke',participant.id,(await body(request,4096)).id));
      if (route.startsWith('admin/')) {
        database.admin.requireAdmin(participant.id); // Authorization precedes parsing or reading anyone else's records.
        if(route==='admin/statistics/tokens'&&request.method==='GET')return send(response,200,{tokens:database.statistics.list(participant.id)});
        if(route==='admin/statistics/tokens'&&request.method==='POST')return send(response,201,database.statistics.create(participant.id,await body(request,4096)));
        if(route==='admin/statistics/tokens/revoke'&&request.method==='POST')return send(response,200,database.statistics.revoke(participant.id,await body(request,4096)));
        if(route==='admin/ai-analysis/tokens'&&request.method==='GET')return send(response,200,{tokens:database.aiAnalysis.integrations.list(participant.id)});
        if(route==='admin/ai-analysis/tokens'&&request.method==='POST')return send(response,201,database.aiAnalysis.integrations.create(participant.id,await body(request,4096)));
        if(route==='admin/ai-analysis/tokens/revoke'&&request.method==='POST')return send(response,200,database.aiAnalysis.integrations.revoke(participant.id,await body(request,4096)));
        if(route==='admin/ai-analysis'&&request.method==='GET')return send(response,200,database.aiAnalysis.overview(participant.id,{before:new URL(request.url,login.origin).searchParams.get('before')??undefined}));
        if(route==='admin/ai-analysis/settings'&&request.method==='POST')return send(response,200,database.aiAnalysis.save(participant.id,await body(request,40000)));
        if(route==='admin/ai-analysis/run'&&request.method==='POST')return send(response,202,database.aiAnalysis.queue(participant.id,await body(request,4096))); // Persist and return immediately; the worker owns inference.
        if(route==='admin/ai-analysis/action'&&request.method==='POST')return send(response,200,database.aiAnalysis.change(participant.id,await body(request,4096)));
        if(route==='admin/ai-analysis/report'&&request.method==='GET')return send(response,200,database.aiAnalysis.report(participant.id,new URL(request.url,login.origin).searchParams.get('id')??''));
        const scope = new URL(request.url, login.origin).searchParams.get('participantId') || '';
        if(route==='admin/notifications'&&request.method==='GET')return send(response,200,database.notifications.messages.overview(participant.id));
        if(route==='admin/notifications'&&request.method==='POST')return send(response,200,database.notifications.messages.queue(participant.id,await body(request,8192)));
        if(route==='admin/notifications/cancel'&&request.method==='POST')return send(response,200,database.notifications.messages.cancel(participant.id,await body(request,4096)));
        if (['admin/reminder','admin/margin-note'].includes(route)) {
          const key=route.slice('admin/'.length);
          if (request.method === 'GET') return send(response,200,database.admin.reminder(key));
          if (request.method === 'POST') return send(response,200,database.admin.saveReminder(participant.id,await body(request,16384),key));
        }
        if (route === 'admin/users' && request.method === 'GET') return send(response, 200, { users: database.admin.users(participant.id), csrf, participant });
        if (route === 'admin/charts' && request.method === 'GET') return send(response, 200, database.admin.charts(participant.id));
        if (route === 'admin/data' && request.method === 'GET') return send(response, 200, database.admin.dataset(participant.id, scope));
        if (route === 'admin/audit' && request.method === 'GET') return send(response, 200, { audit: database.admin.auditList(participant.id) });
        if (route === 'admin/user' && request.method === 'POST') return send(response, 200, database.admin.updateUser(participant.id, await body(request)));
        if (route === 'admin/import-preview' && request.method === 'POST') return send(response, 200, database.admin.previewImport(participant.id, await body(request, 24 * 1024 * 1024)));
        if (route === 'admin/import' && request.method === 'POST') return send(response, 200, database.admin.importData(participant.id, await body(request, 24 * 1024 * 1024)));
      }
      if (route === 'record-reward' && request.method === 'GET') {const id=new URL(request.url,login.origin).searchParams.get('id');return send(response,200,{participant,reward:database.economy.recordReward(participant.id,id),dailyBonus:database.economy.dailyBonusReceipt(participant.id,id)});} // Session ownership controls both receipts; an arbitrary ID cannot award a reward.
      if (route === 'economy' && request.method === 'GET') return send(response, 200, { participant, csrf, ...database.economy.snapshot(participant.id) });
      if(route==='login-bonuses'&&request.method==='GET') {const query=new URL(request.url,login.origin).searchParams;return send(response,200,{participant,...database.economy.loginBonuses(participant.id,{from:query.get('from')??undefined,to:query.get('to')??undefined})});} // This calendar is private; external wallet tokens cannot read it.
      if (route === 'economy' && request.method === 'POST') return send(response, 200, database.economy.act(participant.id, await body(request, 4096)));
      if (route === 'growth-chart' && request.method === 'GET') return send(response, 200, { participant, csrf, ...database.growthChart(participant.id) });
      if (route === 'growth-chart' && request.method === 'POST') return send(response, 200, { participant, ...database.saveGrowthChart(participant.id, await body(request)) });
      if (route === 'session' && request.method === 'GET') return send(response, 200, { participant, csrf, role: session.role, records: database.records(participant.id) });
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
