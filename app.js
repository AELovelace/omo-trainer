import './lib/notifications.js';
import { createRewardCelebration } from './lib/reward-celebration.js';
import { renderPrediction } from './lib/prediction-view.js';
import { DESPERATION_LEVELS, DESPERATION_LABELS, STORAGE_KEY, emptyState, validateState, validateEntry, localDay, localInput,
  timestampFromInput, rollResult, rollProbability, sortedEntries, daySummary, dailySeries, mergeBackup, toCsv } from './lib/model.js';
import { deviceState, emptySync, queueChanges, connectAccount, reconcile, resolveConflict } from './lib/sync.js';
import { isRoll, isObservation } from './lib/model.js';
import { diaperSummary, diaperAtTime, suggestedDiaperWettings } from './lib/diapers.js';
import { trainingState, protocolDay, protocolFor, protocolRecord, cooldownRemaining, instantTimestamp } from './lib/training.js';

import './lib/reminder.js';
import './lib/theme.js';
import './lib/economy.js';
import './lib/games.js';
import './potty_chart/merge.js';
import './potty_chart/account.js';
import './potty_chart/app.js'; // Mount the chart in the same document so navigation retains both chart and observation drafts.

const $ = selector => document.querySelector(selector); // Keeps DOM lookups short while remaining dependency-free.
let chartHeader=null,economyHeader=null;
function renderChartHeader() { // Match the top bar to the current chart, account wallet or scientific recording view.
  const header=location.hash==='#stickers'?economyHeader:location.hash==='#potty-chart'?chartHeader:null;
  if(!header) return;
  $('.local-badge').lastChild.textContent=' '+header.text;
  $('#topbar-sign-in').hidden=header.connected;
}
window.addEventListener('little-log-chart-status',event=>{chartHeader=event.detail;renderChartHeader();});
window.addEventListener('little-log-economy-status',event=>{economyHeader=event.detail;renderChartHeader();});
const navigationDrawer=$('#main-navigation');
const mobileNavigation=window.matchMedia('(max-width: 680px)');
function closeNavigation() { // Native dialog restores focus to the menu opener and keeps background controls out of the tab order while open.
  if(navigationDrawer.open)navigationDrawer.close();
  $('#menu-toggle').setAttribute('aria-expanded','false');
  document.documentElement.classList.remove('navigation-open');
}
function updateNavigationLayout() { // Moves the same links between the desktop sidebar and mobile dialog, preserving the current page.
  const hadFocus=navigationDrawer.contains(document.activeElement);
  closeNavigation();
  (mobileNavigation.matches?navigationDrawer:$('#desktop-navigation')).append($('#navigation-content'));
  if(hadFocus&&!mobileNavigation.matches)$('#navigation-content [aria-current="page"]')?.focus({preventScroll:true});
}
mobileNavigation.addEventListener('change',updateNavigationLayout);
updateNavigationLayout();
$('#menu-toggle').addEventListener('click',()=>{
  if(!mobileNavigation.matches)return;
  if(navigationDrawer.open){closeNavigation();return;}
  navigationDrawer.showModal();
  $('#menu-toggle').setAttribute('aria-expanded','true');
  document.documentElement.classList.add('navigation-open');
});
$('#menu-close').addEventListener('click',closeNavigation);
navigationDrawer.addEventListener('keydown',event=>{ // Wrap keyboard traversal inside the drawer, including its first and last links.
  if(event.key!=='Tab')return;
  const items=[...navigationDrawer.querySelectorAll('button:not([disabled]),a[href]')].filter(el=>el.getClientRects().length);
  const first=items[0],last=items.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
navigationDrawer.addEventListener('cancel',event=>{event.preventDefault();closeNavigation();});
navigationDrawer.addEventListener('close',()=>{if(!navigationDrawer.open)closeNavigation();}); // Escape and programmatic dismissal both restore the same UI state.
let backdropPress=false;
const outsideNavigation=event=>{const bounds=navigationDrawer.getBoundingClientRect();return event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom;};
navigationDrawer.addEventListener('pointerdown',event=>{backdropPress=event.target===navigationDrawer&&outsideNavigation(event);});
navigationDrawer.addEventListener('click',event=>{
  if(backdropPress&&event.target===navigationDrawer&&outsideNavigation(event)){backdropPress=false;closeNavigation();return;}
  backdropPress=false;
  const link=event.target.closest('a[href]');if(!link)return;
  closeNavigation();
  if(link.getAttribute('href').startsWith('#'))requestAnimationFrame(()=>{navigate();$('#main-content').focus({preventScroll:true});}); // Selecting the current page also closes the drawer without clearing forms.
});
window.addEventListener('hashchange',closeNavigation);
const positions = { standing: 'Standing', sitting: 'Sitting', 'laying-down': 'Laying down' };
const categories = { forced: 'Forced', 'semi-forced': 'Semi-Forced', voluntary: 'Voluntary', 'semi-involuntary': 'Semi-involuntary', involuntary: 'Involuntary' };
let editedWetting = null, editedDiaperChange = null;
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
let observationReward = null; // Only the currently open save celebration may receive an asynchronous sticker response.

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const rewardCelebration=createRewardCelebration($('#observation-reward-dialog'),$('#reward-confetti'),$('#reward-sound'),reducedMotion);
let crtPreference = null;
try { crtPreference = localStorage.getItem('ldq-crt-effect'); } catch { /* The display still works when browser storage is unavailable. */ }

function renderCrt() { // Matches the main site's saved display preference and always respects reduced motion.
  const defaultCrt=document.documentElement.dataset.theme==='caregiver-tracker'?'on':'off';
  const enabled = (crtPreference??defaultCrt) !== 'off' && !reducedMotion.matches;
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
window.addEventListener('little-log-theme-changed',renderCrt);
reducedMotion.addEventListener('change', renderCrt);
renderCrt();

function notify(message) { // Announces feedback without moving focus away from the user's current control.
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

function showObservationReward(id) { // Open after the local save; never invent a sticker while server sync is pending.
  rewardCelebration.clear();rewardCelebration.prepare();
  observationReward={id,owner:state.sync.participant?.id??null,loading:false,complete:false,celebrated:false};
  $('#observation-reward-title').textContent='Thank you for checking in!';
  $('#observation-reward-sticker').hidden=true;
  $('#observation-reward-image').removeAttribute('src');
  $('#observation-reward-image').hidden=false;
  $('#observation-reward-name').textContent='';
  $('#observation-reward-retry').hidden=false;
  $('#observation-reward-retry').disabled=false;
  $('#observation-reward-dialog').showModal();
  void refreshObservationReward();
}

async function refreshObservationReward() { // Show the receipt for this exact observation and account, never the latest arbitrary ledger entry.
  const current=observationReward,dialog=$('#observation-reward-dialog'),status=$('#observation-reward-status');
  if(!current||!dialog.open||current.complete||current.loading)return;
  if(current.owner!==(state.sync.participant?.id??null)){dialog.close();return;}
  if(!current.owner){status.textContent='Observation saved on this device. Sign in and sync to receive your sticker.';return;}
  if(!navigator.onLine){status.textContent='Observation saved on this device. Your sticker will appear after you reconnect and sync.';return;}
  if(state.sync.conflicts.some(record=>record.id===current.id)){status.textContent='Observation saved on this device. Review its sync conflict in Settings before collecting your sticker.';return;}
  if(state.sync.queue.some(change=>change.id===current.id)){status.textContent='Observation saved on this device. Your sticker is waiting for this check-in to sync.';return;}
  current.loading=true;status.textContent='Observation saved. Finding your earned sticker?';
  $('#observation-reward-retry').disabled=true;
  try {
    const result=await apiRequest('record-reward?id='+encodeURIComponent(current.id));
    if(current!==observationReward||!dialog.open)return;
    if(result.participant.id!==current.owner||state.sync.participant?.id!==current.owner){dialog.close();return;}
    if(!result.reward){status.textContent='Observation saved. Your sticker is waiting for the collection to become available. Check again shortly.';return;}
    const sticker=result.reward,image=$('#observation-reward-image');
    image.alt=sticker.name;image.src=sticker.url;
    $('#observation-reward-name').textContent=sticker.name;
    $('#observation-reward-sticker').hidden=false;
    $('#observation-reward-title').textContent='You earned a sticker!';
    status.textContent='Thank you for checking in! +1 sticker has been added to your collection.';
    $('#observation-reward-retry').hidden=true;current.complete=true;
  } catch {if(current===observationReward&&dialog.open)status.textContent='Your observation is saved. We could not load your sticker yet. Reconnect or sign in again, then check for your sticker.';}
  finally {current.loading=false;if(current===observationReward)$('#observation-reward-retry').disabled=false;}
}
function celebrateObservationSticker() { // Image load can fire more than once; one visible receipt earns one celebration.
  const current=observationReward,image=$('#observation-reward-image');
  if(!current?.complete||current.celebrated||!$('#observation-reward-dialog').open||!image.naturalWidth||image.hidden)return;
  current.celebrated=true;rewardCelebration.play();
}
$('#observation-reward-image').addEventListener('load',celebrateObservationSticker);
$('#observation-reward-dialog').addEventListener('close',()=>{observationReward=null;rewardCelebration.clear();}); // A delayed response cannot reopen a dismissed celebration.
$('#observation-reward-retry').addEventListener('click',async()=>{rewardCelebration.prepare();await syncNow();await refreshObservationReward();});
$('#observation-reward-image').addEventListener('error',()=>{ // Keep the actual reward name available when its artwork cannot load.
  if(!observationReward)return;
  $('#observation-reward-image').hidden=true;
  $('#observation-reward-status').textContent='Your sticker was added to your collection. Its picture is temporarily unavailable.';
});

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
  $('#admin-nav').hidden = serverSession?.role !== 'admin'; // Navigation follows the server role; admin APIs independently enforce access.
  const sync = state.sync ?? emptySync();
  if(observationReward&&observationReward.owner!==(sync.participant?.id??null))$('#observation-reward-dialog').close();
  let status = 'On this device only';
  if (sync.participant) status = sync.conflicts.length ? `${sync.conflicts.length} conflicts need review` : sync.queue.length ? `${sync.queue.length} changes waiting to sync` : sync.lastSyncedAt ? 'Saved to central database' : 'Waiting for first sync';
  if (syncRunning) status = 'Syncing with lidoll.dev…';
  if (!storageBlocked) $('.local-badge').lastChild.textContent = ` ${status}`;
  $('#sync-status').textContent = syncMessage || status;
  $('#account-status').textContent = sync.participant ? `Connected as ${sync.participant.label}. Participant ID: ${sync.participant.id}` : serverSession ? `Signed in as ${serverSession.participant.label}. Connect this device to upload its entries.` : 'Sign in with your shared LiD0llID account to save entries centrally.';
  $('#connect-account').textContent = sync.participant ? 'Sign in again' : serverSession ? 'Connect & upload my entries' : 'Sign in with LiD0llID';
  $('#connect-account').hidden = Boolean(sync.participant && serverSession);
  $('#register-account').hidden = Boolean(sync.participant || serverSession);
  $('#topbar-sign-in').hidden = Boolean(sync.participant && serverSession);
  $('#topbar-sign-in').textContent = serverSession ? 'Connect device' : sync.participant ? 'Sign in again' : 'Sign in to sync';
  $('#sync-now').hidden = !sync.participant;
  $('#disconnect-account').hidden = !sync.participant && !serverSession;
  $('#sync-now').disabled = syncRunning;
  $('#disconnect-account').disabled = syncRunning;
  renderChartHeader();
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
      window.dispatchEvent(new Event('little-log-rewards-updated'));
      if (!state.sync.queue.length) break;
    }
  } catch (error) { syncMessage = `${error.message} Unsynced changes are kept on this device.`; }
  finally { syncRunning = false; renderSync(); void refreshObservationReward(); }
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


const INTAKE_UNIT_KEY = 'little-log.intake-unit';
const ML_PER_US_FL_OZ = 29.5735295625; // US fluid ounces measure volume; saved observations continue to use whole milliliters.
let intakeUnit = 'ml', intakeRendered = '', intakeDraftMl = null;
try { if (localStorage.getItem(INTAKE_UNIT_KEY) === 'oz') intakeUnit = 'oz'; } catch { /* Unit switching still works without persistent browser storage. */ }

function readIntakeMl() { // Preserve the exact draft while toggling; round only when committing an observation.
  const input = $('#liquids');
  if (!input.value || !Number.isFinite(input.valueAsNumber) || input.valueAsNumber < 0) throw new Error('Enter a valid, nonnegative intake amount.');
  const amount = intakeDraftMl !== null && input.value === intakeRendered ? intakeDraftMl
    : input.valueAsNumber * (intakeUnit === 'oz' ? ML_PER_US_FL_OZ : 1);
  if (amount > 1000000) throw new Error('Intake must be at most 1,000,000 mL.');
  return amount;
}

function displayIntake(amount) { // Update the field, its accessible unit label and decimal keyboard without changing stored records.
  const input = $('#liquids');
  input.step = intakeUnit === 'oz' ? 'any' : '1';
  input.max = String(intakeUnit === 'oz' ? 1000000 / ML_PER_US_FL_OZ : 1000000);
  input.inputMode = intakeUnit === 'oz' ? 'decimal' : 'numeric';
  input.value = amount === null ? '' : String(intakeUnit === 'oz' ? Number((amount / ML_PER_US_FL_OZ).toFixed(2)) : Math.round(amount));
  intakeRendered = input.value; intakeDraftMl = amount;
  $('#intake-unit-label').textContent = intakeUnit === 'oz' ? 'US fl oz' : 'mL';
  $('#intake-unit-toggle').textContent = intakeUnit === 'oz' ? 'Use mL' : 'Use fl oz';
  $('#intake-unit-toggle').setAttribute('aria-label', intakeUnit === 'oz' ? 'Switch intake to milliliters' : 'Switch intake to US fluid ounces');
  $('#intake-unit-help').textContent = intakeUnit === 'oz' ? 'US fluid ounces. 1 fl oz is about 29.57 mL.' : 'Milliliters.';
}

$('#liquids').addEventListener('input', () => { intakeDraftMl = null; }); // Typing a new value replaces any unrounded conversion draft.
$('#intake-unit-toggle').addEventListener('click', () => {
  const input = $('#liquids');
  if (input.validity.badInput || (input.value && !input.reportValidity())) return;
  try {
    const amount = input.value ? readIntakeMl() : null;
    intakeUnit = intakeUnit === 'ml' ? 'oz' : 'ml';
    displayIntake(amount);
    try { localStorage.setItem(INTAKE_UNIT_KEY, intakeUnit); } catch { /* An unavailable preference store never blocks recording. */ }
  } catch (error) { notify(error.message); }
});
displayIntake(0);

function seedForm(day = localDay(), resetLiquids = true) { // Carries the active diaper across dates; only intake drafts reset after saving.
  if (resetLiquids) displayIntake(0);
  $('#diaper').value = diaperSummary(state.entries, day).currentDiaper;
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
  const message = remaining > 0 ? `Next roll in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. Wetting and observation logging remain available.` : 'Ready to roll. A Hold result starts a 10-minute roll cooldown.';
  const status = $('#cooldown-status');
  if (status.textContent !== message) status.textContent = message;
}

function renderProtocol() { // Shows the current chance and an auditable daily breakdown, counting actual events only.
  protocolView = trainingState(state.entries);
  const view = protocolView, counts = view.counts;
  $('#probability').value = view.probability;
  $('#protocol-probability').textContent = `${view.probability}%`;
  $('#protocol-summary').textContent = view.protocol ? `Enrolled ${view.start} · Days use ${view.timeZone}. Today's base chance comes from completed days. Random adjustments can change the base; a 100% roll is temporary.` : 'Starts at 50% with your first saved check-in, wetting, or roll. Earlier, unclassified snapshots are kept in your archive.';
  $('#protocol-today').textContent = `Today: F ${counts.forced} · SF ${counts['semi-forced']} · V ${counts.voluntary} · SI ${counts['semi-involuntary']} · I ${counts.involuntary}. If today ended now: ${view.nextProbability}%.`;
  $('#protocol-days').innerHTML = view.days.slice(-90).reverse().map(day => `<tr><th scope="row">${day.day}</th><td>${day.forced}</td><td>${day['semi-forced']}</td><td>${day.voluntary}</td><td>${day['semi-involuntary']}</td><td>${day.involuntary}</td><td>${day.adjustment > 0 ? '+' : ''}${day.adjustment} pp</td><td>${day.before}% → ${day.probability}%</td></tr>`).join('');
  renderCooldown();
}

function formEntry(form, original = null) { // Reads a snapshot; editing an unchanged timestamp preserves its exact original offset and seconds.
  const values = new FormData(form);
  const input = values.get('occurredAt');
  const occurredAt = original && input === original.occurredAt.slice(0, 16) ? original.occurredAt : timestampFromInput(input);
  return {
    id: original?.id ?? crypto.randomUUID(),
    occurredAt,
    liquidsMl: form.id === 'log-form' ? Math.round(readIntakeMl()) : Number(values.get('liquidsMl')), // Recording accepts either unit; the existing edit form explicitly uses mL.
    ...(values.has('position') ? { position: values.get('position') } : {}),
    diaperNumber: Number(values.get('diaperNumber')),
    ...(values.has('wettingsCount') ? { wettingsCount: Number(values.get('wettingsCount')) } : {}),
    ...(values.has('probability') ? { probability: Number(values.get('probability')) } : {}), // Only legacy combined records have an editable probability.
  };
}

function renderSummary() { // Renders today's snapshots separately from historical or future-dated entries.
  const summary = daySummary(state.entries, localDay());
  const diapers = diaperSummary(state.entries, localDay());
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('#stat-rolls').textContent = summary.count.toLocaleString();
  $('#stat-results').textContent = summary.pee + summary.hold ? `${summary.pee} pee · ${summary.hold} hold` : 'No roll results today';
  $('#stat-liquids').textContent = summary.liquidsMl.toLocaleString();
  $('#stat-diaper').textContent = String(diapers.changes);
  $('#stat-wettings').textContent = diapers.wettings + ' wettings in changed diapers';
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
  $('#chart').innerHTML = `<svg viewBox="0 0 450 207" role="img" aria-label="${days}-day ${isLiquid ? 'daily logged intake in milliliters' : 'pee and hold entry counts'} chart. Exact values are in View chart data.">${grid}${bars}</svg>`;
  $('#chart-data').innerHTML = series.map(row => `<tr><th scope="row">${row.day}</th><td>${row.pee}</td><td>${row.hold}</td><td>${row.liquidsMl}</td></tr>`).join('');
  $('#chart-legend').hidden = isLiquid;
  const count = series.reduce((sum, row) => sum + (isLiquid ? row.liquidsMl : row.pee + row.hold), 0);
  $('#chart-caption').textContent = count ? (isLiquid ? 'Adds intake since each check-in; older cumulative snapshots are counted once. Intake is assigned to the check-in date.' : `${count} results over ${days} days. Independent rolls and legacy results shown by day.`) : 'No observations yet. Your first check-in starts the record.';
}

function entryLabel(entry) { // Gives each persisted record kind a factual label without inventing an outcome.
  return entry.kind === 'diaper-change' ? 'Diaper change' : entry.kind === 'wetting' ? categories[entry.category] : entry.kind === 'observation' ? 'Check-in' : entry.result === 'pee' ? 'Pee' : 'Hold';
}

function renderRecent() { // Includes standalone rolls without borrowing unsaved intake or position fields.
  const recent = sortedEntries(state.entries.filter(entry => entry.kind !== 'protocol')).slice(0, 4);
  $('#recent-list').innerHTML = recent.length ? recent.map(entry => {
    const description = entry.kind === 'diaper-change' ? entry.wettingsCount + ' wettings before change' : entry.kind === 'roll' ? 'Roll at ' + entry.probability + '%' : entry.kind === 'wetting' ? 'Wetting event' : entry.liquidsMl.toLocaleString() + ' mL ' + (entry.kind === 'observation' ? 'since last check-in' : 'daily cumulative');
    const position = (entry.position ? ' &middot; ' + positions[entry.position] : '') + (entry.diaperNumber ? ' &middot; Diaper #' + entry.diaperNumber : '');
    return `<div class="recent-entry"><span class="entry-icon ${entry.result ?? 'pee'}"><svg class="icon"><use href="#i-${entry.result === 'hold' ? 'clock' : 'drop'}"/></svg></span><div class="entry-info"><strong>${dateLabel(entry.occurredAt)}</strong><p>${description}${position}${entry.desperation ? " &middot; Desperation: " + DESPERATION_LABELS[entry.desperation] : ""}</p></div><span class="result-pill ${entry.result ?? 'pee'}">${entryLabel(entry)}</span></div>`;
  }).join('') : '<div class="empty-state">NO OBSERVATIONS FILED<br>Your saved observations and rolls will appear here.</div>';
}

function filteredEntries() { // Applies inclusive calendar-day filters using each entry's recorded local date.
  const from = $('#filter-from').value, to = $('#filter-to').value, result = $('#filter-result').value;
  return sortedEntries(state.entries).filter(entry => entry.kind !== 'protocol').filter(entry => {
    const day = entry.occurredAt.slice(0, 10);
    return (!from || day >= from) && (!to || day <= to) && (result === 'all' || result === entry.kind || (isRoll(entry) && result === entry.result));
  });
}

function renderHistory() { // Limits initial table size while keeping filters and CSV export over the full matching set.
  const entries = filteredEntries();
  const visible = entries.slice(0, historyLimit);
  $('#history-count').textContent = $('#filter-from').value && $('#filter-to').value && $('#filter-from').value > $('#filter-to').value ? 'Choose an end date on or after the start date.' : `${entries.length} matching observations · ${visible.length} shown. CSV exports all matching entries.`;
  $('#history-empty').hidden = entries.length > 0;
  $('#load-more').hidden = entries.length <= historyLimit;
  $('#history-body').innerHTML = visible.map(entry => {
    const intake = isObservation(entry) ? entry.liquidsMl.toLocaleString() + ' mL<small>' + (entry.kind === 'observation' ? 'Since last check-in' : 'Daily cumulative') + '</small>' : '&mdash;';
    const wettings = entry.kind === 'diaper-change' ? entry.wettingsCount + '<small>Before change</small>' : entry.kind === 'wetting' ? '1 event' + (entry.wettingsCount === undefined ? '' : '<small>' + entry.wettingsCount + ' in diaper</small>') : entry.wettingsCount ?? '&mdash;';
    const probability = isRoll(entry) ? entry.probability + '%' : '&mdash;';
    const provenance = entry.kind === 'diaper-change' ? 'Completed diaper' : entry.kind === 'observation' ? 'Observation' : entry.kind === 'wetting' ? 'Wetting' : entry.source === 'random' ? 'Rolled' : 'Manual (legacy)';
    const edit = entry.kind === 'roll' ? '' : `<button class="text-button" data-edit="${entry.id}" aria-label="Edit record ${dateLabel(entry.occurredAt)}">Edit</button>`;
    return `<tr><td>${dateLabel(entry.occurredAt)}<small>${entry.occurredAt.slice(0, 10)} &middot; UTC${entry.occurredAt.slice(-6)}</small></td><td>${intake}</td><td>${positions[entry.position] ?? '&mdash;'}</td><td>${entry.diaperNumber ? '#' + entry.diaperNumber : '&mdash;'}</td><td>${wettings}</td><td>${probability}</td><td><span class="result-pill ${entry.result ?? 'pee'}">${entryLabel(entry)}</span><small>${provenance}${entry.desperation ? ' &middot; Desperation: ' + DESPERATION_LABELS[entry.desperation] : ''}${entry.edited ? ' &middot; edited' : ''}</small></td><td>${edit}<button class="text-button" data-delete="${entry.id}" aria-label="Delete record ${dateLabel(entry.occurredAt)}">Delete</button></td></tr>`;
  }).join('');
}

function render() { // Refreshes derived views without erasing unsaved form inputs or settings changes.
  renderProtocol();
  renderSummary();
  renderChart();
  renderPrediction(state.entries, state.sync.participant?.id, true);
  renderRecent();
  renderHistory();
  renderSync();
  seedDiaperChange();
}

function navigate() { // Implements accessible, bookmarkable pages without requiring server-side route rewrites.
  const requested = location.hash.slice(1);
  const page = ['overview', 'history', 'settings', 'about', 'potty-chart', 'stickers', 'games'].includes(requested) ? requested : 'overview';
  const action = ['observation', 'wetting', 'change', 'roll', 'analysis'].includes(requested) ? requested : 'observation';
  document.querySelectorAll('[data-mobile-panel]').forEach(panel => {
    panel.dataset.active = String(panel.dataset.mobilePanel === action); // CSS switches mobile panels without clearing their forms or hiding desktop cards.
  });
  document.querySelectorAll('[data-action]').forEach(link => {
    const selected = page === 'overview' && link.dataset.action === action;
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (page === 'overview' && requested === action) {
    requestAnimationFrame(() => {
      const panel = document.querySelector('[data-mobile-panel="' + action + '"]');
      panel.querySelector('h2').focus({ preventScroll: true }); // Announce the destination without opening the phone keyboard.
      panel.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }

  document.querySelectorAll('.page').forEach(section => { section.hidden = section.id !== `page-${page}`; });
  document.querySelectorAll('[data-page]').forEach(link => {
    const selected = link.dataset.page === page;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  renderSync();
  if(page==='potty-chart') {
    window.dispatchEvent(new Event('little-log-chart-visible'));
    requestAnimationFrame(()=>$('#potty-page-title').focus({preventScroll:true}));
  }
  if(page==='games') requestAnimationFrame(()=>$('#games-title').focus({preventScroll:true})); // Announce Games without losing any unsaved tracker or chart inputs.
  document.title = `${page === 'overview' ? 'Little Log' : page === 'history' ? 'Record archive · Little Log' : page === 'potty-chart' ? 'Potty chart · Little Log' : page === 'games' ? 'Games · Little Log' : page === 'stickers' ? 'Stickers & market' : page === 'about' ? 'About · Little Log' : 'Settings · Little Log'} · lidoll.dev`;
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

$('#log-form').addEventListener('submit', event => { // Saves interval intake and a snapshot without drawing or starting a cooldown.
  event.preventDefault();
  try {
    const base = formEntry(event.currentTarget);
    if (!$('#occurred-at').dataset.edited) base.occurredAt = instantTimestamp();
    refreshStoredState();
    const candidate = validateEntry({ ...base, kind: 'observation', liquidsMode: 'interval' });
    commit({ ...state, entries: [...enroll(state.entries), candidate] });
    $('#occurred-at').value = localInput();
    seedForm();
    showObservationReward(candidate.id);
    navigator.storage?.persist?.().catch(() => {});
  } catch (error) { notify(error.message); }
});

$('#roll-desperation').addEventListener('input',event=>{ // Present the four named steps to both sighted users and screen readers.
  const label=DESPERATION_LABELS[DESPERATION_LEVELS[Number(event.target.value)]];
  $('#roll-desperation-value').value=label;
  event.target.setAttribute('aria-valuetext',label);
});
$('.roll-button').addEventListener('click', () => { // Draws independently, leaving every unsaved observation field untouched.
  try {
    refreshStoredState();
    const now = new Date();
    if (cooldownRemaining(state.entries, now) > 0) throw new Error('The previous Hold result is still in its 10-minute cooldown.');
    const entries = enroll(state.entries, now), variation=rollProbability(trainingState(entries, now).probability);
    const {probability}=variation; // Sample only on a real roll, after the cooldown check; never on render or reload.
    const result = rollResult(probability), occurredAt = instantTimestamp(now);
    const candidate = validateEntry({ id: crypto.randomUUID(), kind: 'roll', occurredAt, ...variation, result,
      source: 'random', rolledAt: occurredAt, rolledResult: result, position: $('.roll-card input[name="position"]:checked').value,
      desperation: DESPERATION_LEVELS[Number($('#roll-desperation').value)] });
    const enrollment = protocolFor(entries);
    const savedEntries = result === 'hold'
      ? entries.map(entry => entry.id === enrollment.id ? { ...entry, lastFailureAt: occurredAt } : entry) : entries;
    commit({ ...state, entries: [...savedEntries, candidate] });
    $('#roll-result').textContent = `Rolled: ${result === 'pee' ? 'Pee' : 'Hold'} at ${probability}%. Desperation: ${DESPERATION_LABELS[candidate.desperation]}. Roll saved. You're always free to use the bathroom.`;
    $('#roll-result').hidden = false;
  } catch (error) { notify(error.message); }
});

$('#occurred-at').addEventListener('change', event => { // Resets daily counters only when the selected date changes.
  const day = event.target.value.slice(0, 10);
  if (day && day !== formDay) seedForm(day, false);
});
$('#wetting-time').addEventListener('input', event => { event.target.dataset.edited = 'true'; }); // Keeps backdated event times stable while the live clock advances.
$('#wetting-form').addEventListener('submit', event => { // Saves one classified event without rolling, even during a cooldown or while offline.
  event.preventDefault();
  try {
    refreshStoredState();
    const values = new FormData(event.currentTarget);
    const occurredAt = $('#wetting-time').dataset.edited ? timestampFromInput(values.get('occurredAt')) : instantTimestamp(); // Keep seconds for a new event immediately after a recorded change.
    const entry = validateEntry({ id: crypto.randomUUID(), kind: 'wetting', occurredAt,
      category: values.get('category'), position: values.get('position'), diaperNumber: diaperAtTime(state.entries, occurredAt) });
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
      category: values.get('category'), position: values.get('position'), diaperNumber: Number(values.get('diaperNumber')), edited: true,
      ...(current.wettingsCount === undefined ? {} : { wettingsCount: Number(values.get('wettingsCount')) }) });
    if (Date.parse(next.occurredAt) > Date.now()) throw new Error('A wetting must describe an event that has already happened.');
    commit({ ...state, entries: state.entries.map(entry => entry.id === next.id ? next : entry) });
    $('#wetting-edit-dialog').close();
    notify('Wetting corrected. Daily probability recalculated.');
  } catch (error) { notify(error.message); }
});
function seedDiaperChange(reset = false) { // Preserve typed totals while refreshing the day's saved change count and untouched suggestions.
  if (reset) for (const selector of ['#diaper-change-number', '#diaper-change-wettings']) delete $(selector).dataset.edited;
  const input = $('#diaper-change-time'), day = input.value.slice(0, 10) || localDay();
  const summary = diaperSummary(state.entries, day);
  $('#diaper-change-summary').textContent = summary.changes + ' changes recorded on ' + day + '. This will add change #' + (summary.changes + 1) + '.';
  let before = null;
  try { if (input.value) before = input.dataset.edited ? timestampFromInput(input.value) : instantTimestamp(); }
  catch { $('#diaper-change-summary').textContent = 'Choose a valid date and time for this change.'; return; }
  if (reset || !$('#diaper-change-number').dataset.edited) $('#diaper-change-number').value = before ? diaperAtTime(state.entries, before) : summary.currentDiaper;
  if (reset || !$('#diaper-change-wettings').dataset.edited) {
    $('#diaper-change-wettings').value = suggestedDiaperWettings(state.entries, day, Number($('#diaper-change-number').value), before);
  }
}
$('#diaper-change-time').addEventListener('input', event => { event.target.dataset.edited = 'true'; });
$('#diaper-change-time').addEventListener('change', () => {
  delete $('#diaper-change-number').dataset.edited; delete $('#diaper-change-wettings').dataset.edited; seedDiaperChange(true);
});
$('#diaper-change-number').addEventListener('input', event => {
  event.target.dataset.edited = 'true'; delete $('#diaper-change-wettings').dataset.edited; seedDiaperChange();
});
$('#diaper-change-wettings').addEventListener('input', event => { event.target.dataset.edited = 'true'; });
$('#diaper-change-form').addEventListener('submit', event => { // Record one completed diaper with its final count; no classified wetting or roll is created.
  event.preventDefault();
  try {
    refreshStoredState();
    const values = new FormData(event.currentTarget);
    const entry = validateEntry({ id: crypto.randomUUID(), kind: 'diaper-change',
      occurredAt: $('#diaper-change-time').dataset.edited ? timestampFromInput(values.get('occurredAt')) : instantTimestamp(),
      diaperNumber: Number(values.get('diaperNumber')), wettingsCount: Number(values.get('wettingsCount')) });
    if (Date.parse(entry.occurredAt) > Date.now()) throw new Error('A diaper change must have already happened.');
    commit({ ...state, entries: [...enroll(state.entries), entry] });
    $('#diaper-change-time').value = localInput();
    for (const selector of ['#diaper-change-time', '#diaper-change-number', '#diaper-change-wettings']) delete $(selector).dataset.edited;
    seedDiaperChange(true);
    $('#diaper').value = diaperSummary(state.entries, $('#occurred-at').value.slice(0, 10) || localDay()).currentDiaper;
    notify('Diaper change saved with its final wetting count.');
  } catch (error) { notify(error.message); }
});
$('#close-diaper-change-edit').addEventListener('click', () => $('#diaper-change-edit-dialog').close());
$('#diaper-change-edit-form').addEventListener('submit', event => { // Corrections use the same conflict-aware record queue as observations.
  event.preventDefault();
  try {
    refreshStoredState();
    const current = state.entries.find(entry => entry.id === editedDiaperChange?.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(editedDiaperChange)) throw new Error('This diaper change changed. Close and reopen the editor.');
    const values = new FormData(event.currentTarget), time = values.get('occurredAt');
    const next = validateEntry({ ...current, occurredAt: time === current.occurredAt.slice(0, 16) ? current.occurredAt : timestampFromInput(time),
      diaperNumber: Number(values.get('diaperNumber')), wettingsCount: Number(values.get('wettingsCount')), edited: true });
    if (Date.parse(next.occurredAt) > Date.now()) throw new Error('A diaper change must have already happened.');
    commit({ ...state, entries: state.entries.map(entry => entry.id === next.id ? next : entry) });
    $('#diaper-change-edit-dialog').close(); notify('Diaper change corrected.');
  } catch (error) { notify(error.message); }
});
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
    if (!editedEntry || editedEntry.kind === 'roll') return;
    if (editedEntry.kind === 'diaper-change') {
      editedDiaperChange = editedEntry;
      $('#diaper-change-edit-time').value = editedEntry.occurredAt.slice(0, 16);
      $('#diaper-change-edit-number').value = editedEntry.diaperNumber;
      $('#diaper-change-edit-wettings').value = editedEntry.wettingsCount;
      $('#diaper-change-edit-dialog').showModal(); return;
    }
    if (editedEntry.kind === 'wetting') {
      editedWetting = editedEntry;
      const form = $('#wetting-edit-form');
      for (const key of ['category', 'position', 'diaperNumber']) form.elements.namedItem(key).value = editedWetting[key];
      $('#wetting-edit-count').value = editedWetting.wettingsCount ?? '';
      $('#wetting-edit-count').required = editedWetting.wettingsCount !== undefined;
      $('#wetting-edit-count').disabled = editedWetting.wettingsCount === undefined;
      $('#legacy-wetting-count').hidden = editedWetting.wettingsCount === undefined;
      $('#wetting-edit-time').value = editedWetting.occurredAt.slice(0, 16);
      $('#wetting-edit-dialog').showModal();
      return;
    }
    $('#edit-liquids').previousElementSibling.textContent = editedEntry.kind === 'observation' ? 'Liquids since previous check-in (mL)' : 'Daily cumulative liquids (mL)';
    for (const id of ['#edit-probability', '#edit-result']) $(id).disabled = editedEntry.kind === 'observation';
    $('#edit-probability').closest('.field-pair').hidden = editedEntry.kind === 'observation';
    for (const key of ['id', 'liquidsMl', 'position', 'diaperNumber', 'wettingsCount', 'probability', 'result']) $('#edit-form').elements.namedItem(key).value = editedEntry[key] ?? '';
    for (const [selector, key] of [['#edit-position', 'position'], ['#edit-wettings', 'wettingsCount']]) {
      $(selector).disabled = editedEntry[key] === undefined;
      $(selector).parentElement.hidden = editedEntry[key] === undefined; // Historical snapshots keep their original editable fields.
    }
    $('#edit-time').value = editedEntry.occurredAt.slice(0, 16);
    $('#edit-dialog').showModal();
  }
  if (remove && confirm('Delete this record? This cannot be undone.')) {
    try { commit({ ...state, entries: state.entries.filter(entry => entry.id !== remove.dataset.delete) }); notify('Record deleted.'); }
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
document.querySelectorAll('[data-action]').forEach(link => link.addEventListener('click', () => {
  if (location.hash === link.getAttribute('href')) navigate(); // Tapping the active action returns to its form after scrolling down.
}));
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

function refreshClock() { // Advances live timestamps and daily summaries while retaining the active diaper across midnight.
  const today = localDay();
  const input = $('#occurred-at');
  const changedDay = today !== activeDay;
  if (!input.dataset.edited && document.activeElement !== input) {
    input.value = localInput();
    if (changedDay) seedForm(today, false);
  }
  if (changedDay || (protocolView && protocolView.today !== protocolDay(new Date(), protocolView.timeZone))) { activeDay = today; render(); }
  const wettingTime = $('#wetting-time');
  if (!wettingTime.dataset.edited && document.activeElement !== wettingTime) {
    wettingTime.value = localInput();
  }
  const changeTime = $('#diaper-change-time');
  if (!changeTime.dataset.edited && document.activeElement !== changeTime) {
    const previousDay = changeTime.value.slice(0, 10);
    changeTime.value = localInput();
    if (previousDay !== today) seedDiaperChange(true);
  }
  renderCooldown();
  renderPrediction(state.entries, state.sync.participant?.id);
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
  location.assign('./auth/login'+(location.hash==='#potty-chart'?'?returnTo=growth-chart':''));
});
$('#disconnect-account').addEventListener('click', async () => { // Clears this device only after ending its app session; centralized records remain available on the next sign-in.
  if (syncRunning) return notify('Wait for the current sync to finish before signing out.');
  if (!confirm('Sign out of Little Log and clear observations and the potty chart on this device? Server records stay saved. Any unsynced changes on this device will be lost; export a backup first to keep them.')) return;
  try {
    if (!serverSession) serverSession = await apiRequest('session');
    await apiRequest('logout', {});
    if (localStorage.getItem(STORAGE_KEY) !== persistedRaw) throw new Error('Data changed in another tab. Reload before clearing it.');
    localStorage.removeItem(STORAGE_KEY);
    persistedRaw = null;
    state = deviceState(emptyState());
    window.dispatchEvent(new Event('little-log-signout')); // Clear both integrated views after the shared session ends.
    serverSession = null;
    syncMessage = '';
    sessionStorage.removeItem('little-log.connect');
    setDefaults(); seedForm(); render();
    notify('Signed out of Little Log. Your central records were kept.');
  } catch (error) { notify(error.message); }
});

loadState();
$('#diaper-change-time').value = localInput();
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
