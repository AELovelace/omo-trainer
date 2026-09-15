// Install beside Little Log's notifications.mjs; no extra dependencies or access to individual records.
export function createLittlepottchiBridge(db, options = {}) {
  const base = options.baseUrl ?? process.env.LITTLEPOTTCHI_API_URL ?? '';
  const token = options.token ?? process.env.LITTLEPOTTCHI_BRIDGE_TOKEN ?? '';
  const fetcher = options.fetch ?? globalThis.fetch;
  let running = false, cursor = 0, lastError = null;
  if (!base && !token) return {tick: async () => {}, status: () => ({configured:false,lastError:null})};
  let url;
  try { url = new URL(base); } catch { throw Error('Set LITTLEPOTTCHI_API_URL to the pet integration API.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/littlepottchi/integration/v1/') ||
      token.length < 32 || token.length > 512 || /\s/.test(token)) throw Error('Invalid Littlepottchi bridge URL or credential.');
  db.exec(`CREATE TABLE IF NOT EXISTS littlepottchi_push_deliveries(event TEXT NOT NULL,endpoint TEXT NOT NULL,created INTEGER NOT NULL,
    PRIMARY KEY(event,endpoint));
    CREATE TABLE IF NOT EXISTS littlepottchi_bridge_state(id INTEGER PRIMARY KEY CHECK(id=1),report_id TEXT NOT NULL,finished INTEGER NOT NULL);`);

  async function request(path, body) {
    const response = await fetcher(new URL(path, url), {method:body ? 'POST' : 'GET',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${token}`,...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
    if (!response.ok) throw Error('Littlepottchi bridge request failed.');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length;
        if (size > 262144) throw Error('Littlepottchi bridge response too large.'); chunks.push(Buffer.from(value)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); }
  } // Never forward the service credential through redirects, and bound network time and response size.

  async function syncAnalysis() {
    const report = db.prepare("SELECT id,finished,input FROM ai_analysis_jobs WHERE status='completed' AND input IS NOT NULL ORDER BY finished DESC,id DESC LIMIT 1").get();
    if (!report) return;
    const saved = db.prepare('SELECT * FROM littlepottchi_bridge_state WHERE id=1').get();
    // Re-send the latest immutable snapshot even after bot database recovery; uploads are idempotent.
    const aggregate = JSON.parse(report.input);
    if (!Array.isArray(aggregate.days) || !String(aggregate.scope).startsWith('All participants')) throw Error('Expected a community analysis snapshot.');
    if (!aggregate.days.some(day => day.activeParticipants > 0)) return;
    const result = await request('analysis', {reportId:report.id,finished:report.finished,
      days:aggregate.days.map(({date,wettings,activeParticipants}) => ({date,wettings,activeParticipants}))});
    if (!result.accepted && !result.stale) throw Error('Littlepottchi did not accept the analysis.');
    if (!saved || saved.report_id !== report.id || saved.finished !== report.finished) db.prepare(
      'INSERT INTO littlepottchi_bridge_state VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET report_id=excluded.report_id,finished=excluded.finished').run(report.id,report.finished);
  } // Read the exact saved AI input, never regenerate statistics or export names, free text or raw histories.

  function recipient(event, now) {
    if (!event || !/^[\w-]{36}$/.test(event.id) || !Number.isSafeInteger(event.expires) || event.expires <= now ||
        !['wet','mess','leak','feed','water','play','rest','complete'].includes(event.kind) ||
        typeof event.recipient?.issuer !== 'string' || typeof event.recipient?.subject !== 'string') return null;
    return db.prepare(`SELECT p.id,n.time_zone,n.quiet_start,n.quiet_end FROM participants p
      JOIN notification_preferences n ON n.owner=p.id WHERE p.issuer=? AND p.subject=?
      AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=p.id AND a.disabled=1)`).get(event.recipient.issuer,event.recipient.subject);
  } // Resolve the exact OIDC identity; labels and caller-supplied local participant IDs never route pushes.

  async function tick(now = Date.now()) {
    if (running) return; running = true; lastError = null;
    try {
      try { await syncAnalysis(); } catch { lastError = 'Analysis synchronization failed; it will retry.'; }
      if (!options.configured) return;
      const page = await request(`events?after=${cursor}&limit=10`);
      if (!Array.isArray(page.events) || page.events.length > 10 || !Number.isSafeInteger(page.nextAfter) || page.nextAfter < cursor) throw Error('Invalid pet event page.');
      const ack = [], started = Date.now(); let attempts = 0;
      for (const event of page.events) {
        const owner = recipient(event, now);
        if (!owner) { if (/^[\w-]{36}$/.test(event?.id)) ack.push(event.id); continue; }
        const {hour} = options.localBlock(now, owner.time_zone), start = owner.quiet_start, end = owner.quiet_end;
        if (start !== end && (start < end ? hour >= start && hour < end : hour >= start || hour < end)) continue;
        const subscriptions = db.prepare('SELECT endpoint,payload FROM push_subscriptions WHERE owner=?').all(owner.id);
        for (const sub of subscriptions) {
          if (attempts >= 10 || Date.now() - started >= 15000) break;
          if (!recipient(event, now) || !db.prepare('SELECT 1 FROM push_subscriptions WHERE owner=? AND endpoint=?').get(owner.id, sub.endpoint)) continue;
          if (!db.prepare('INSERT OR IGNORE INTO littlepottchi_push_deliveries VALUES (?,?,?)').run(event.id,sub.endpoint,now).changes) continue;
          attempts++;
          try { await options.send(JSON.parse(sub.payload), {kind:'littlepottchi',need:event.kind,title:'Littlepottchi',tag:`littlepottchi-${event.id}`}); }
          catch (error) {
            if ([404,410].includes(error.statusCode)) db.prepare('DELETE FROM push_subscriptions WHERE owner=? AND endpoint=?').run(owner.id,sub.endpoint);
          } // Journal before sending: an uncertain push result is not repeated after a crash or lost API acknowledgement.
        }
        if (subscriptions.every(sub => db.prepare('SELECT 1 FROM littlepottchi_push_deliveries WHERE event=? AND endpoint=?').get(event.id,sub.endpoint))) ack.push(event.id);
      }
      if (ack.length) await request('events/ack', {ids:ack});
      cursor = page.more ? page.nextAfter : 0; // Revisit quiet-hour and partially delivered events on the next pass.
      db.prepare('DELETE FROM littlepottchi_push_deliveries WHERE created<?').run(now - 7 * 86400000);
    } catch { lastError = 'Pet notification synchronization failed; it will retry.'; }
    finally { running = false; }
  }
  return {tick,status:() => ({configured:true,lastError})};
} // An optional poller uses Little Log's existing subscriptions and quiet hours; no real push is sent in tests.
