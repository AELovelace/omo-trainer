import { isRoll, WETTING_CATEGORIES, timestampFromInput, localInput } from './model.js';

export const COOLDOWN_MS = 10 * 60 * 1000;
const clamp = value => Math.max(20, Math.min(80, value)); // Applies the protocol bounds after each completed day.
let dayFormatter, formatterZone; // Reuses the reporting formatter across large event histories and the visible countdown.

export function instantTimestamp(now = new Date()) { // Records the actual roll instant with seconds, independently of a backdated observation field.
  const timestamp = timestampFromInput(localInput(now));
  return timestamp.slice(0, 16) + `:${String(now.getSeconds()).padStart(2, '0')}` + timestamp.slice(-6);
}

export function protocolRecord(now = new Date()) { // Saves the enrollment date and a stable reporting timezone as an ordinary synced record.
  return { id: crypto.randomUUID(), kind: 'protocol', occurredAt: instantTimestamp(now), protocolVersion: 1,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export function protocolFor(entries) { // Concurrent offline enrollments converge on the earliest enrollment, with an ID tie-breaker.
  return entries.filter(entry => entry.kind === 'protocol').sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

export function protocolDay(instant, timeZone) { // Groups instants in the enrollment timezone, including DST and travel between devices.
  if (formatterZone !== timeZone) {
    dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatterZone = timeZone;
  }
  const parts = dayFormatter.formatToParts(new Date(instant));
  const part = type => parts.find(value => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function dayAdjustment(counts) { // Compare the original five classifications only; bedwetting and potty use have no protocol weight.
  const deliberate = counts.forced + (counts['semi-forced'] ?? 0) + counts.voluntary; // SF joins F/V; older count objects have no SF field.
  const other = counts['semi-involuntary'] + counts.involuntary;
  return deliberate + other === 0 || deliberate < other ? 5 : -5;
}

export function trainingState(entries, now = new Date()) { // Replays completed calendar days once; rerenders and restarts cannot apply a day twice.
  const protocol = protocolFor(entries);
  const timeZone = protocol?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = protocolDay(now, timeZone);
  const start = protocol ? protocolDay(protocol.occurredAt, timeZone) : today;
  const emptyCounts = () => Object.fromEntries(WETTING_CATEGORIES.map(category => [category, 0]));
  const grouped = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'wetting') continue;
    const day = protocolDay(entry.occurredAt, timeZone);
    const counts = grouped.get(day) ?? emptyCounts();
    counts[entry.category]++;
    grouped.set(day, counts);
  }
  const bonuses=new Map();
  for(const entry of entries.filter(e=>e.kind==='roll'&&e.rollRuleVersion===2&&Date.parse(e.occurredAt)<=Number(now)).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id))) {
    const delta=entry.probabilityModifier==='increase'?10:entry.probabilityModifier==='decrease'?-10:0;
    if(!delta)continue;
    const day=protocolDay(entry.occurredAt,timeZone);if(day<start)continue;
    const list=bonuses.get(day)??[];list.push(delta);bonuses.set(day,list);
  }
  let probability = 50;
  const applyBonuses=day=>{for(const delta of bonuses.get(day)??[])probability=clamp(probability+delta);}; // Replay each persistent random change before that day's midnight adjustment; a 100% draw never changes the base.
  const days = [];
  for (let cursor = Date.parse(`${start}T12:00:00Z`); new Date(cursor).toISOString().slice(0, 10) < today; cursor += 86400000) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    applyBonuses(day);
    const counts = grouped.get(day) ?? emptyCounts();
    const adjustment = dayAdjustment(counts), before = probability;
    probability = clamp(probability + adjustment);
    days.push({ day, ...counts, adjustment, before, probability });
  }
  applyBonuses(today);
  const counts = grouped.get(today) ?? emptyCounts();
  return { protocol, timeZone, today, start, probability, days, counts, nextProbability: clamp(probability + dayAdjustment(counts)) };
}

export function cooldownRemaining(entries, now = Date.now()) { // Original draw timestamps/results survive corrections; manual observations never start a cooldown.
  let until = 0;
  for (const entry of entries) {
    if (entry.kind === 'protocol' && entry.lastFailureAt) until = Math.max(until, Date.parse(entry.lastFailureAt) + COOLDOWN_MS);
    if (isRoll(entry) && entry.source === 'random' && (entry.rolledResult ?? entry.result) === 'hold') {
      until = Math.max(until, Date.parse(entry.rolledAt ?? entry.occurredAt) + COOLDOWN_MS);
    }
  }
  return Math.max(0, until - Number(now));
}
