import { STORAGE_KEY, emptyState, validateState, validateEntry, localDay, localInput,
  timestampFromInput, rollResult, sortedEntries, daySummary, dailySeries, mergeBackup, toCsv } from './lib/model.js';
import { deviceState, emptySync, queueChanges, connectAccount, reconcile, resolveConflict } from './lib/sync.js';
import { isRoll } from './lib/model.js';
import { trainingState, protocolDay, protocolFor, protocolRecord, cooldownRemaining, instantTimestamp } from './lib/training.js';

const $ = selector => document.querySelector(selector); // Keeps DOM lookups short while remaining dependency-free.
const positions = { standing: 'Standing', sitting: 'Sitting', 'laying-down': 'Laying down' };
const categories = { forced: 'Forced', voluntary: 'Voluntary', 'semi-involuntary': 'Semi-involuntary', involuntary: 'Involuntary' };
let editedWetting = null;
let protocolView;
let state = deviceState(emptyState());
let persistedRaw = null;
let storageBlocked = false;
let chartMetric = 'entries';
let historyLimit = 100;
let toastTimer;
let installPrompt;
let editedEntry = null;
let activeDay = localDay();
let formDay = activeDay;
let serverSession = null;
let syncRunning = false;
let syncMessage = '';
let renderedConflicts = '';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let crtPreference = null;
try { crtPreference = localStorage.getItem('ldq-crt-effect'); } catch { /* The display still works when browser storage is unavailable. */ }

function renderCrt() { // Matches the main site's saved display preference and always respects reduced motion.
  const enabled = crtPreference !== 'off' && !reducedMotion.matches;
  document.documentElement.classList.toggle('crt-enabled', enabled);
  $('#crt-toggle').setAttribute('aria-pressed', String(enabled));
  $('#crt-toggle').textContent = `CRT FX // ${enabled ? 'ON' : 'OFF'}`;
  $('#crt-toggle').disabled = reducedMotion.matches;
  $('#crt-toggle').title = reducedMotion.matches ? 'CRT texture is disabled by your reduced-motion preference.' : 'Toggle the static terminal scanline texture.';
}

$('#crt-toggle').addEventListener('click', () => { // Saves a cosmetic preference separately from observation records and their sync queue.
  crtPreference = document.documentElement.classList.contains('crt-enabled') ? 'off' : 'on';
  renderCrt();
  try { localStorage.setItem('ldq-crt-effect', crtPreference); }
  catch { notify('Display changed for this visit. Your browser could not save the preference.'); }
});
reducedMotion.addEventListener('change', renderCrt);
renderCrt();

function notify(message) { // Announces feedback without moving focus away from the user's current control.
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

function storageWarning(message) { // Makes storage failures persistent instead of falsely reporting a successful save.
  $('#storage-warning').textContent = message;
  $('#storage-warning').hidden = false;
  $('.local-badge').lastChild.textContent = ' Storage needs attention';
}

function loadState() { // Leaves corrupt data untouched so the owner can export the original for recovery.
  try {
    persistedRaw = localStorage.getItem(STORAGE_KEY);
    state = persistedRaw ? deviceState(JSON.parse(persistedRaw)) : deviceState(emptyState());
  } catch {
    storageBlocked = true;
    storageWarning('Saved data could not be read. Existing data has been left untouched and new saves are paused. Download a backup in Settings before clearing or recovering it.');
  }
}

function commit(nextState, fromServer = false) { // Atomically saves records and their upload queue before reporting success.
  if (storageBlocked) throw new Error('Saving is paused. Back up your existing data in Settings first.');
  const clean = fromServer ? deviceState(nextState) : queueChanges(state, nextState);
  try {
    if (localStorage.getItem(STORAGE_KEY) !== persistedRaw) {
      throw new Error('Your records changed in another tab. Reload this page before saving.');
    }
    const serialized = JSON.stringify(clean);
    localStorage.setItem(STORAGE_KEY, serialized);
    persistedRaw = serialized;
  } catch (error) {
    storageWarning(`Could not save: ${error.message} Your previous records are unchanged. Export a backup from Settings if storage is full.`);
    throw new Error('This change was not saved. See the storage notice above.');
  }
  state = clean;
  $('#storage-warning').hidden = true;
  render();
  if (!fromServer) void syncNow();
}

function renderSync() { // Separates local saving, pending uploads, conflicts, and confirmed server persistence.
  const sync = state.sync ?? emptySync();
  let status = 'On this device only';
  if (sync.participant) status = sync.conflicts.length ? `${sync.conflicts.length} conflicts need review` : sync.queue.length ? `${sync.queue.length} changes waiting to sync` : sync.lastSyncedAt ? 'Saved to central database' : 'Waiting for first sync';
  if (syncRunning) status = 'Syncing with lidoll.dev…';
  if (!storageBlocked) $('.local-badge').lastChild.textContent = ` ${status}`;
  $('#sync-status').textContent = syncMessage || status;
  $('#account-status').textContent = sync.participant ? `Connected as ${sync.participant.label}. Participant ID: ${sync.participant.id}` : serverSession ? `Signed in as ${serverSession.participant.label}. Connect this device to upload its entries.` : 'Sign in with your shared lidoll.dev account to save entries centrally.';
  $('#connect-account').textContent = sync.participant ? 'Sign in again' : serverSession ? 'Connect & upload my entries' : 'Sign in with lidoll.dev';
  $('#connect-account').hidden = Boolean(sync.participant && serverSession);
  $('#register-account').hidden = Boolean(sync.participant || serverSession);
  $('#topbar-sign-in').hidden = Boolean(sync.participant && serverSession);
  $('#topbar-sign-in').textContent = serverSession ? 'Connect device' : sync.participant ? 'Sign in again' : 'Sign in to sync';
  $('#sync-now').hidden = !sync.participant;
  $('#disconnect-account').hidden = !sync.participant && !serverSession;
  $('#sync-now').disabled = syncRunning;
  $('#disconnect-account').disabled = syncRunning;
  const conflictKey = JSON.stringify(sync.conflicts);
  if (conflictKey === renderedConflicts) return; // Status-only refreshes must not detach a conflict button while it is focused or being clicked.
  renderedConflicts = conflictKey;
  const list = $('#sync-conflicts');
  list.replaceChildren();
  for (const conflict of sync.conflicts) {
    const item = document.createElement('div');
    item.className = 'sync-conflict';
    const title = document.createElement('strong');
    title.textContent = `Check-in ${conflict.local?.occurredAt ?? conflict.entry?.occurredAt ?? conflict.id}`;
    const detail = document.createElement('pre');
    detail.textContent = `Your device: ${conflict.local ? JSON.stringify(conflict.local, null, 2) : 'Deleted'}\nServer: ${conflict.entry ? JSON.stringify(conflict.entry, null, 2) : 'Deleted'}`;
    item.append(title, detail);
    for (const [label, useLocal] of [['Keep my device version', true], ['Use server version', false]]) {
      const button = document.createElement('button');
      button.className = 'button secondary';
      button.textContent = label;
      button.addEventListener('click', () => {
        try { commit(resolveConflict(state, conflict.id, useLocal), true); void syncNow(); }
        catch (error) { notify(error.message); }
      });
      item.append(button);
    }
    list.append(item);
  }
}

async function apiRequest(route, changes) { // Uses same-origin HttpOnly sessions; only a CSRF token is exposed to browser code.
  const response = await fetch(`./api/${route}`, {
    method: changes === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: changes === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': serverSession?.csrf ?? '' },
    ...(changes === undefined ? {} : { body: JSON.stringify(changes) }),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('The sync service is not available yet. Entries remain on this device.'); }
  if (!response.ok) {
    if (response.status === 401) serverSession = null;
    throw new Error(result.error || 'Sync failed. Your device will retry.');
  }
  return result;
}

function refreshStoredState() { // Incorporates another tab's saves before applying a response that arrived over the network.
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== persistedRaw) { state = raw ? deviceState(JSON.parse(raw)) : deviceState(emptyState()); persistedRaw = raw; }
}

async function syncNow() { // Retries durable mutations in bounded batches; a lost response can be replayed without duplicating records.
  if (syncRunning || storageBlocked || !state.sync.participant || !navigator.onLine) { renderSync(); return; }
  syncRunning = true;
  syncMessage = '';
  renderSync();
  try {
    serverSession = await apiRequest('session');
    refreshStoredState();
    if (serverSession.participant.id !== state.sync.participant?.id) throw new Error('Another account is signed in. Reconnect the correct account before syncing these records.');
    for (let batch = 0; batch < 10; batch++) {
      const participantId = state.sync.participant.id;
      const sent = state.sync.queue.slice(0, 100);
      const response = await apiRequest('sync', { changes: sent });
      refreshStoredState();
      if (state.sync.participant?.id !== participantId) return;
      if (response.participant.id !== participantId) throw new Error('The server account changed during sync.');
      commit(reconcile(state, response), true);
      if (!state.sync.queue.length) break;
    }
  } catch (error) { syncMessage = `${error.message} Unsynced changes are kept on this device.`; }
  finally { syncRunning = false; renderSync(); }
}

async function checkSession() { // Restores a signed-in browser after redirect without uploading old local records before the connection action.
  try {
    serverSession = await apiRequest('session');
    if (sessionStorage.getItem('little-log.connect') === '1') {
      refreshStoredState();
      commit(connectAccount(state, serverSession.participant, serverSession.records), true);
      sessionStorage.removeItem('little-log.connect');
    }
    if (state.sync.participant) await syncNow();
  } catch (error) { if (state.sync.participant || sessionStorage.getItem('little-log.connect')) syncMessage = error.message; }
  renderSync();
}

function dateLabel(timestamp, includeDate = true) { // Shows the recorded wall-clock time, even after the viewer changes timezone.
  const date = new Date(`${timestamp.slice(0, 19)}Z`);
  return date.toLocaleString(undefined, { timeZone: 'UTC', ...(includeDate ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
}

function seedForm(day = localDay()) { // Carries forward the latest same-day counts and resets counts for a new day.
  const latest = daySummary(state.entries, day).latest;
  $('#liquids').value = latest?.liquidsMl ?? 0;
  $('#diaper').value = latest?.diaperNumber ?? 1;
  $('#wettings').value = latest?.wettingsCount ?? 0;
  formDay = day;
}

function setDefaults() { // Applies saved preferences only at startup or when the user explicitly saves defaults.
  $(`input[name="position"][value="${state.settings.position}"]`).checked = true;
  $('#wetting-position').value = state.settings.position;
  $('#default-position').value = state.settings.position;
}

function enroll(entries, now = new Date()) { // Enrollment starts on the first new observation, and survives deleting individual observations.
  return protocolFor(entries) ? entries : [...entries, protocolRecord(now)];
}

function renderCooldown() { // Uses wall-clock deadlines rather than decrementing a timer that pauses in background tabs.
  const remaining = cooldownRemaining(state.entries);
  $('.roll-button').disabled = remaining > 0 || storageBlocked;
  const seconds = Math.ceil(remaining / 1000);
  const message = remaining > 0 ? `Next roll in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. Wetting and manual logging remain available.` : 'Ready to roll. A Hold result starts a 10-minute roll cooldown.';
  const status = $('#cooldown-status');
  if (status.textContent !== message) status.textContent = message;
}

function renderProtocol() { // Shows the current chance and an auditable daily breakdown, counting actual events only.
  protocolView = trainingState(state.entries);
  const view = protocolView, counts = view.counts;
  $('#probability').value = view.probability;
  $('#probability-slider').value = view.probability;
  $('#protocol-probability').textContent = `${view.probability}%`;
  $('#protocol-summary').textContent = view.protocol ? `Enrolled ${view.start} · Days use ${view.timeZone}. Today's chance is fixed by completed days.` : 'Starts at 50% with your first new observation. Earlier, unclassified snapshots are kept in your archive.';
  $('#protocol-today').textContent = `Today: F ${counts.forced} · V ${counts.voluntary} · SI ${counts['semi-involuntary']} · I ${counts.involuntary}. If today ended now: ${view.nextProbability}%.`;
  $('#protocol-days').innerHTML = view.days.slice(-90).reverse().map(day => `<tr><th scope="row">${day.day}</th><td>${day.forced}</td><td>${day.voluntary}</td><td>${day['semi-involuntary']}</td><td>${day.involuntary}</td><td>${day.adjustment > 0 ? '+' : ''}${day.adjustment} pp</td><td>${day.before}% → ${day.probability}%</td></tr>`).join('');
  renderCooldown();
}

function formEntry(form, original = null) { // Reads a snapshot; editing an unchanged timestamp preserves its exact original offset and seconds.
  const values = new FormData(form);
  const input = values.get('occurredAt');
  const occurredAt = original && input === original.occurredAt.slice(0, 16) ? original.occurredAt : timestampFromInput(input);
  return {
    id: original?.id ?? crypto.randomUUID(),
    occurredAt,
    liquidsMl: Number(values.get('liquidsMl')),
    position: values.get('position'),
    diaperNumber: Number(values.get('diaperNumber')),
    wettingsCount: Number(values.get('wettingsCount')),
    probability: Number(values.get('probability')),
  };
}

function renderSummary() { // Renders today's snapshots separately from historical or future-dated entries.
  const summary = daySummary(state.entries, localDay());
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('#stat-rolls').textContent = summary.count.toLocaleString();
  $('#stat-results').textContent = summary.count ? `${summary.pee} pee · ${summary.hold} hold` : 'Awaiting first entry';
  $('#stat-liquids').textContent = summary.liquidsMl.toLocaleString();
  $('#stat-diaper').textContent = summary.latest ? `#${summary.latest.diaperNumber}` : '—';
  $('#stat-wettings').textContent = summary.latest ? `${summary.latest.wettingsCount} wettings in this diaper` : 'No check-ins yet';
}

function renderChart() { // Draws real daily data and supplies an equivalent table for screen readers and exact values.
  const days = Number($('#chart-days').value);
  const series = dailySeries(state.entries, days);
  const isLiquid = chartMetric === 'liquids';
  const maximum = Math.max(isLiquid ? 100 : 4, ...series.map(row => isLiquid ? row.liquidsMl : row.pee + row.hold));
  const ceiling = Math.ceil(maximum / 4) * 4;
  const left = 42, top = 12, width = 388, height = 158, bottom = top + height;
  const slot = width / days;
  const barWidth = Math.min(27, slot * .55);
  const heightFor = value => value / ceiling * height;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const y = top + height * index / 4;
    return `<line x1="${left}" x2="${left + width}" y1="${y}" y2="${y}" stroke="var(--chart-grid)" stroke-dasharray="3 5"/><text x="${left - 9}" y="${y + 3}" text-anchor="end">${Math.round(ceiling * (1 - index / 4)).toLocaleString()}</text>`;
  }).join('');
  const bars = series.map((row, index) => {
    const x = left + slot * (index + .5) - barWidth / 2;
    const peeHeight = heightFor(row.pee), holdHeight = heightFor(row.hold);
    const title = `${row.day}: ${row.pee} pee, ${row.hold} hold, ${row.liquidsMl} mL`;
    const rectangles = isLiquid
      ? `<rect x="${x}" y="${bottom - heightFor(row.liquidsMl)}" width="${barWidth}" height="${heightFor(row.liquidsMl)}" rx="3" fill="var(--chart-liquid)"/>`
      : `<rect x="${x}" y="${bottom - peeHeight}" width="${barWidth}" height="${peeHeight}" rx="2" fill="var(--chart-pee)"/><rect x="${x}" y="${bottom - peeHeight - holdHeight}" width="${barWidth}" height="${holdHeight}" rx="2" fill="var(--chart-hold)"/>`;
    const showLabel = days === 7 || index === 0 || index === days - 1 || index % Math.ceil(days / 5) === 0;
    const label = new Date(`${row.day}T12:00:00`).toLocaleDateString(undefined, days === 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
    return `<g><title>${title}</title>${rectangles}${showLabel ? `<text x="${x + barWidth / 2}" y="${bottom + 23}" text-anchor="middle">${label}</text>` : ''}</g>`;
  }).join('');
  $('#chart').innerHTML = `<svg viewBox="0 0 450 207" role="img" aria-label="${days}-day ${isLiquid ? 'daily cumulative liquids in milliliters' : 'pee and hold entry counts'} chart. Exact values are in View chart data.">${grid}${bars}</svg>`;
  $('#chart-data').innerHTML = series.map(row => `<tr><th scope="row">${row.day}</th><td>${row.pee}</td><td>${row.hold}</td><td>${row.liquidsMl}</td></tr>`).join('');
  $('#chart-legend').hidden = isLiquid;
  const count = series.reduce((sum, row) => sum + row.pee + row.hold, 0);
  $('#chart-caption').textContent = count ? (isLiquid ? 'Daily totals use the highest logged cumulative amount.' : `${count} check-ins over ${days} days. Pee and hold results shown by day.`) : 'No observations yet. Your first check-in starts the record.';
}

function renderRecent() { // Lists both observation types while keeping enrollment metadata out of the activity feed.
  const recent = sortedEntries(state.entries.filter(entry => entry.kind !== 'protocol')).slice(0, 4);
  $('#recent-list').innerHTML = recent.length ? recent.map(entry => {
    const wetting = entry.kind === 'wetting';
    const label = wetting ? categories[entry.category] : entry.result === 'pee' ? 'Pee' : 'Hold';
    const icon = wetting || entry.result === 'pee' ? 'drop' : 'clock';
    const description = wetting ? 'Wetting event' : entry.liquidsMl.toLocaleString() + ' mL';
    return `<div class="recent-entry"><span class="entry-icon ${entry.result ?? 'pee'}"><svg class="icon"><use href="#i-${icon}"/></svg></span><div class="entry-info"><strong>${dateLabel(entry.occurredAt)}</strong><p>${description} &middot; ${positions[entry.position]} &middot; Diaper #${entry.diaperNumber}</p></div><span class="result-pill ${entry.result ?? 'pee'}">${label}</span></div>`;
  }).join('') : '<div class="empty-state"><svg class="empty-sigil" aria-hidden="true"><use href="#i-sigil"/></svg>NO OBSERVATIONS FILED<br>Your saved observations will appear here.</div>';
}

function filteredEntries() { // Applies inclusive calendar-day filters using each entry's recorded local date.
  const from = $('#filter-from').value, to = $('#filter-to').value, result = $('#filter-result').value;
  return sortedEntries(state.entries).filter(entry => entry.kind !== 'protocol').filter(entry => {
    const day = entry.occurredAt.slice(0, 10);
    return (!from || day >= from) && (!to || day <= to) && (result === 'all' || result === (entry.kind ?? entry.result));
  });
}

function renderHistory() { // Limits initial table size while keeping filters and CSV export over the full matching set.
  const entries = filteredEntries();
  const visible = entries.slice(0, historyLimit);
  $('#history-count').textContent = $('#filter-from').value && $('#filter-to').value && $('#filter-from').value > $('#filter-to').value ? 'Choose an end date on or after the start date.' : `${entries.length} matching observations · ${visible.length} shown. CSV exports all matching entries.`;
  $('#history-empty').hidden = entries.length > 0;
  $('#load-more').hidden = entries.length <= historyLimit;
  $('#history-body').innerHTML = visible.map(entry => `<tr><td>${dateLabel(entry.occurredAt)}<small>${entry.occurredAt.slice(0, 10)} · UTC${entry.occurredAt.slice(-6)}</small></td><td>${entry.kind === 'wetting' ? '\u2014' : entry.liquidsMl.toLocaleString() + ' mL'}</td><td>${positions[entry.position]}</td><td>#${entry.diaperNumber}</td><td>${entry.kind === 'wetting' ? '1 event' : entry.wettingsCount}</td><td>${entry.kind === 'wetting' ? '\u2014' : entry.probability + '%'}</td><td><span class="result-pill ${entry.result}">${entry.kind === 'wetting' ? categories[entry.category] : entry.result === 'pee' ? 'Pee' : 'Hold'}</span><small>${entry.kind === 'wetting' ? 'Wetting' : entry.source === 'random' ? 'Rolled' : 'Manual'}${entry.edited ? ' · edited' : ''}</small></td><td><button class="text-button" data-edit="${entry.id}" aria-label="Edit check-in ${dateLabel(entry.occurredAt)}">Edit</button><button class="text-button" data-delete="${entry.id}" aria-label="Delete check-in ${dateLabel(entry.occurredAt)}">Delete</button></td></tr>`).join('');
}

function render() { // Refreshes derived views without erasing unsaved form inputs or settings changes.
  renderProtocol();
  renderSummary();
  renderChart();
  renderRecent();
  renderHistory();
  renderSync();
}

function navigate() { // Implements accessible, bookmarkable pages without requiring server-side route rewrites.
  const requested = location.hash.slice(1);
  const page = ['overview', 'history', 'settings', 'about'].includes(requested) ? requested : 'overview';
  document.querySelectorAll('.page').forEach(section => { section.hidden = section.id !== `page-${page}`; });
  document.querySelectorAll('[data-page]').forEach(link => {
    const selected = link.dataset.page === page;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = `${page === 'overview' ? 'Little Log' : page === 'history' ? 'Record archive · Little Log' : page === 'about' ? 'About · Little Log' : 'Settings · Little Log'} · lidoll.dev`;
}

function download(filename, data, type) { // Generates an on-device download; no records are sent to a remote endpoint.
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('#log-form').addEventListener('submit', event => { // Validates, draws once, and persists the resulting snapshot as one user action.
  event.preventDefault();
  try {
    const base = formEntry(event.currentTarget);
    const source = event.submitter?.value === 'manual' ? 'manual' : 'random';
    refreshStoredState();
    const now = new Date();
    if (source === 'random' && cooldownRemaining(state.entries, now) > 0) throw new Error('The previous Hold result is still in its 10-minute cooldown.');
    const entries = enroll(state.entries, now);
    const probability = trainingState(entries, now).probability;
    const candidate = validateEntry({ ...base, probability, source, result: 'hold' });
    candidate.result = source === 'random' ? rollResult(candidate.probability) : $('#manual-result').value;
    if (source === 'random') { candidate.rolledAt = instantTimestamp(now); candidate.rolledResult = candidate.result; }
    const enrollment = protocolFor(entries);
    const savedEntries = source === 'random' && candidate.result === 'hold'
      ? entries.map(entry => entry.id === enrollment.id ? { ...entry, lastFailureAt: candidate.rolledAt } : entry)
      : entries; // Retains the deadline even when an individual failed observation is later deleted.
    commit({ ...state, entries: [...savedEntries, candidate] });
    $('#roll-result').textContent = `${source === 'random' ? 'Rolled' : 'Logged'}: ${candidate.result === 'pee' ? 'Pee' : 'Hold'} · ${candidate.probability}% pee chance. Check-in saved. You're always free to use the bathroom.`;
    $('#roll-result').hidden = false;
    $('#occurred-at').value = localInput();
    seedForm();
    navigator.storage?.persist?.().catch(() => {}); // Requests best-effort eviction protection, never treats it as a backup guarantee.
  } catch (error) { notify(error.message); }
});

$('#occurred-at').addEventListener('change', event => { // Resets daily counters only when the selected date changes.
  const day = event.target.value.slice(0, 10);
  if (day && day !== formDay) seedForm(day);
});
$('#wetting-time').addEventListener('input', event => { event.target.dataset.edited = 'true'; }); // Keeps backdated event times stable while the live clock advances.
$('#wetting-form').addEventListener('submit', event => { // Saves one classified event without rolling, even during a cooldown or while offline.
  event.preventDefault();
  try {
    refreshStoredState();
    const values = new FormData(event.currentTarget);
    const entry = validateEntry({ id: crypto.randomUUID(), kind: 'wetting', occurredAt: timestampFromInput(values.get('occurredAt')),
      category: values.get('category'), position: values.get('position'), diaperNumber: Number(values.get('diaperNumber')) });
    if (Date.parse(entry.occurredAt) > Date.now()) throw new Error('A wetting must describe an event that has already happened.');
    commit({ ...state, entries: [...enroll(state.entries), entry] });
    $('#wetting-category').value = '';
    $('#wetting-time').value = localInput();
    delete $('#wetting-time').dataset.edited;
    notify('Wetting saved. One event added to the daily classification totals.');
  } catch (error) { notify(error.message); }
});
$('#close-wetting-edit').addEventListener('click', () => $('#wetting-edit-dialog').close());
$('#wetting-edit-form').addEventListener('submit', event => { // Corrects event metadata through the existing durable queue and conflict protection.
  event.preventDefault();
  try {
    const current = state.entries.find(entry => entry.id === editedWetting?.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(editedWetting)) throw new Error('This wetting changed. Close and reopen the editor.');
    const values = new FormData(event.currentTarget), input = values.get('occurredAt');
    const next = validateEntry({ ...current, occurredAt: input === current.occurredAt.slice(0, 16) ? current.occurredAt : timestampFromInput(input),
      category: values.get('category'), position: values.get('position'), diaperNumber: Number(values.get('diaperNumber')), edited: true });
    if (Date.parse(next.occurredAt) > Date.now()) throw new Error('A wetting must describe an event that has already happened.');
    commit({ ...state, entries: state.entries.map(entry => entry.id === next.id ? next : entry) });
    $('#wetting-edit-dialog').close();
    notify('Wetting corrected. Daily probability recalculated.');
  } catch (error) { notify(error.message); }
});
$('#new-diaper').addEventListener('click', () => { // Advances the day's diaper number and starts its wetting count at zero.
  const current = Number($('#diaper').value);
  if (!Number.isInteger(current) || current < 1 || current >= 10000) return notify('Enter a diaper number from 1 to 9,999 before adding a new one.');
  $('#diaper').value = current + 1;
  $('#wettings').value = 0;
  notify(`Diaper #${current + 1} selected. Save a check-in to record the change.`);
});
$('#diaper').addEventListener('change', () => { // Restores a selected diaper's latest count, or zero for a previously unlogged diaper.
  const latest = sortedEntries(state.entries).find(entry => entry.occurredAt.startsWith(`${formDay}T`) && entry.diaperNumber === Number($('#diaper').value));
  $('#wettings').value = latest?.wettingsCount ?? 0;
});
$('#probability-slider').addEventListener('input', event => { $('#probability').value = event.target.value; }); // Synchronizes the whole-number slider with its editable value.
$('#probability').addEventListener('input', event => { if (event.target.validity.valid) $('#probability-slider').value = event.target.value; });
$('#chart-days').addEventListener('change', renderChart);
document.querySelectorAll('[data-metric]').forEach(button => button.addEventListener('click', () => { // Switches chart metrics without changing stored records.
  chartMetric = button.dataset.metric;
  document.querySelectorAll('[data-metric]').forEach(tab => {
    tab.classList.toggle('active', tab === button);
    tab.setAttribute('aria-pressed', String(tab === button));
  });
  renderChart();
}));
['#filter-from', '#filter-to', '#filter-result'].forEach(selector => $(selector).addEventListener('change', () => { historyLimit = 100; renderHistory(); }));
$('#clear-filters').addEventListener('click', () => { // Clears every history filter together.
  $('#filter-from').value = '';
  $('#filter-to').value = '';
  $('#filter-result').value = 'all';
  historyLimit = 100;
  renderHistory();
});
$('#load-more').addEventListener('click', () => { historyLimit += 100; renderHistory(); });
$('#history-body').addEventListener('click', event => { // Delegates actions so history can rerender without attaching duplicate listeners.
  const edit = event.target.closest('[data-edit]'), remove = event.target.closest('[data-delete]');
  if (edit) {
    editedEntry = state.entries.find(entry => entry.id === edit.dataset.edit);
    if (!editedEntry) return;
    if (editedEntry.kind === 'wetting') {
      editedWetting = editedEntry;
      const form = $('#wetting-edit-form');
      for (const key of ['category', 'position', 'diaperNumber']) form.elements.namedItem(key).value = editedWetting[key];
      $('#wetting-edit-time').value = editedWetting.occurredAt.slice(0, 16);
      $('#wetting-edit-dialog').showModal();
      return;
    }
    for (const key of ['id', 'liquidsMl', 'position', 'diaperNumber', 'wettingsCount', 'probability', 'result']) $('#edit-form').elements.namedItem(key).value = editedEntry[key];
    $('#edit-time').value = editedEntry.occurredAt.slice(0, 16);
    $('#edit-dialog').showModal();
  }
  if (remove && confirm('Delete this check-in? This cannot be undone.')) {
    try { commit({ ...state, entries: state.entries.filter(entry => entry.id !== remove.dataset.delete) }); notify('Check-in deleted.'); }
    catch (error) { notify(error.message); }
  }
});
$('#close-edit').addEventListener('click', () => $('#edit-dialog').close());
$('#edit-form').addEventListener('submit', event => { // Marks corrections explicitly and keeps the original random/manual provenance.
  event.preventDefault();
  try {
    const current = state.entries.find(entry => entry.id === editedEntry?.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(editedEntry)) throw new Error('This entry changed in another tab. Close the editor and open it again.');
    const next = validateEntry({ ...editedEntry, ...formEntry(event.currentTarget, editedEntry), source: editedEntry.source, result: new FormData(event.currentTarget).get('result'), edited: true });
    commit({ ...state, entries: state.entries.map(entry => entry.id === next.id ? next : entry) });
    $('#edit-dialog').close();
    notify('Changes saved.');
  } catch (error) { notify(error.message); }
});
$('#settings-form').addEventListener('submit', event => { // Persists preferences with the same validation and storage protections as entries.
  event.preventDefault();
  try {
    commit({ ...state, settings: { probability: state.settings.probability, position: $('#default-position').value } });
    setDefaults();
    notify('Your defaults are saved.');
  } catch (error) { notify(error.message); }
});
$('#export-csv').addEventListener('click', () => download(`little-log-${localDay()}.csv`, toCsv(filteredEntries()), 'text/csv;charset=utf-8'));
$('#export-json').addEventListener('click', () => { // Exports unreadable raw data as well, allowing recovery without overwriting it.
  const data = storageBlocked && persistedRaw !== null ? persistedRaw : JSON.stringify(validateState(state), null, 2);
  download(`little-log-${storageBlocked ? 'recovery-' : ''}${localDay()}.json`, data, 'application/json');
});
$('#import-json').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => { // Rejects oversized or invalid backups before attempting an atomic merge.
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose a backup smaller than 25 MB.');
    const parsed = JSON.parse(await file.text());
    const merged = mergeBackup(state, parsed);
    commit(merged.state);
    notify(`Imported ${merged.added} new check-ins. Existing entries and defaults were kept.`);
  } catch (error) { notify(error instanceof SyntaxError ? 'That file is not valid JSON. Choose a Little Log backup.' : error.message); }
  finally { event.target.value = ''; }
});
$('#delete-all').addEventListener('click', () => { // Removes only this app's namespace after explicit confirmation, leaving other lidoll.dev data alone.
  if (state.sync?.participant) {
    if (!confirm('Delete every check-in for this account? Deletions will sync to the central database and your other devices. Export a backup first if you want to keep them.')) return;
    try { commit({ ...state, entries: [], settings: emptyState().settings }); setDefaults(); seedForm(); notify('Deletions saved on this device and queued for the server.'); }
    catch (error) { notify(error.message); }
    return;
  }
  if (!confirm('Permanently delete all Little Log entries and settings from this browser? Download a backup first if you want to keep them.')) return;
  try {
    if (localStorage.getItem(STORAGE_KEY) !== persistedRaw) throw new Error('Data changed in another tab. Reload before deleting.');
    localStorage.removeItem(STORAGE_KEY);
    persistedRaw = null;
    storageBlocked = false;
    state = deviceState(emptyState());
    $('#storage-warning').hidden = true;
    $('.local-badge').lastChild.textContent = ' Saved on this device';
    $('#occurred-at').value = localInput();
    $('#roll-result').hidden = true;
    setDefaults();
    seedForm();
    render();
    notify('Local entries and settings deleted.');
  } catch (error) { notify(`Could not delete data: ${error.message}`); }
});

window.addEventListener('hashchange', navigate);
window.addEventListener('storage', event => { // Adopts changes from another tab while preserving any in-progress form edits.
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state = raw ? deviceState(JSON.parse(raw)) : deviceState(emptyState());
    persistedRaw = raw;
    storageBlocked = false;
    render();
    notify('Records updated from another tab. Your unsaved form is unchanged.');
  } catch { storageBlocked = true; storageWarning('Another tab saved data this app cannot read. Reload before making changes.'); }
});
window.addEventListener('beforeinstallprompt', event => { // Shows an install control only when the browser supplies a usable install prompt.
  event.preventDefault();
  installPrompt = event;
  $('#install-button').hidden = false;
});
$('#install-button').addEventListener('click', async () => {
  if (!installPrompt) return;
  try { await installPrompt.prompt(); await installPrompt.userChoice; }
  finally { installPrompt = null; $('#install-button').hidden = true; }
});
window.addEventListener('appinstalled', () => { $('#install-button').hidden = true; notify('Little Log terminal installed. Ready for observations.'); });

function refreshClock() { // Advances untouched live timestamps and resets automatic daily defaults when midnight passes.
  const today = localDay();
  const input = $('#occurred-at');
  const changedDay = today !== activeDay;
  if (!input.dataset.edited && document.activeElement !== input) {
    input.value = localInput();
    if (changedDay) seedForm(today);
  }
  if (changedDay || (protocolView && protocolView.today !== protocolDay(new Date(), protocolView.timeZone))) { activeDay = today; render(); }
  const wettingTime = $('#wetting-time');
  if (!wettingTime.dataset.edited && document.activeElement !== wettingTime) wettingTime.value = localInput();
  renderCooldown();
}
$('#occurred-at').addEventListener('input', () => { $('#occurred-at').dataset.edited = 'true'; });
$('#log-form').addEventListener('submit', () => { if ($('#occurred-at').value === localInput()) delete $('#occurred-at').dataset.edited; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshClock(); });
setInterval(refreshClock, 1000);
setInterval(() => { if (!document.hidden) void syncNow(); }, 30000);
window.addEventListener('online', () => { void checkSession(); });

$('#connect-account').addEventListener('click', async () => { // Makes migration of existing local entries an explicit action tied to the selected shared account.
  try {
    if (serverSession) {
      refreshStoredState();
      commit(connectAccount(state, serverSession.participant, serverSession.records), true);
      await syncNow();
    } else {
      sessionStorage.setItem('little-log.connect', '1');
      location.assign('./auth/login');
    }
  } catch (error) { notify(error.message); }
});
$('#sync-now').addEventListener('click', () => { void syncNow(); });
$('#register-account').addEventListener('click', () => { // Creates a shared identity before returning through the existing explicit upload/connection flow.
  try { sessionStorage.removeItem('little-log.connect'); } catch { /* Registration itself does not require browser session storage. */ }
  location.assign('./auth/register');
});
$('#topbar-sign-in').addEventListener('click', () => { // Opens shared sign-in from any page; first-time uploads still require the Settings disclosure and connection choice.
  if (serverSession) {
    location.hash = 'settings';
    navigate(); // Reveal Settings before focusing its connection button; hashchange may run after the next animation frame.
    $('#connect-account').focus();
    return;
  }
  try { sessionStorage.removeItem('little-log.connect'); } catch { /* Shared sign-in can still proceed without a saved upload preference. */ }
  location.assign('./auth/login');
});
$('#disconnect-account').addEventListener('click', async () => { // Clears this device only after ending its app session; centralized records remain available on the next sign-in.
  if (syncRunning) return notify('Wait for the current sync to finish before signing out.');
  if (!confirm('Sign out of Little Log and clear its device copy? Server records stay saved. Any unsynced changes on this device will be lost; export a backup first to keep them.')) return;
  try {
    if (!serverSession) serverSession = await apiRequest('session');
    await apiRequest('logout', {});
    if (localStorage.getItem(STORAGE_KEY) !== persistedRaw) throw new Error('Data changed in another tab. Reload before clearing it.');
    localStorage.removeItem(STORAGE_KEY);
    persistedRaw = null;
    state = deviceState(emptyState());
    serverSession = null;
    syncMessage = '';
    sessionStorage.removeItem('little-log.connect');
    setDefaults(); seedForm(); render();
    notify('Signed out of Little Log. Your central records were kept.');
  } catch (error) { notify(error.message); }
});

loadState();
$('#wetting-time').value = localInput();
$('#occurred-at').value = localInput();
setDefaults();
seedForm();
render();
navigate();
void checkSession();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(async registration => { // Limits offline caching to this app's directory.
    await navigator.serviceWorker.ready;
    $('#offline-status').textContent = 'Offline support is ready on this browser.';
    if (registration.waiting) notify('An app update is ready. Close all Little Log tabs and reopen to use it.');
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', event => {
        if (event.target.state === 'installed' && navigator.serviceWorker.controller) notify('An update is ready. Close all Little Log tabs and reopen when convenient.');
      });
    });
  }).catch(() => { $('#offline-status').textContent = 'Offline setup did not finish. Reconnect and reload to try again.'; });
} else $('#offline-status').textContent = 'Offline support needs HTTPS or localhost and a browser that supports service workers.';
