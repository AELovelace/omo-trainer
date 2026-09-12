export const STORAGE_KEY = 'lidoll.little-log.v1';
export const POSITIONS = ['standing', 'sitting', 'laying-down'];
export const DEFAULT_SETTINGS = Object.freeze({ probability: 50, position: 'sitting' });
export const MAX_ENTRIES = 50000; // Bounds imports and rendering work without imposing a daily logging quota.
export const WETTING_CATEGORIES = ['forced', 'semi-forced', 'voluntary', 'semi-involuntary', 'involuntary'];
export const isRoll = entry => entry.kind === undefined || entry.kind === 'roll'; // Legacy combined snapshots remain readable alongside independent draws.
export const isObservation = entry => entry.kind === undefined || entry.kind === 'observation'; // Only check-ins carry intake and diaper snapshots.

export function emptyState() { // Returns independent defaults so a new device starts with no personal records.
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, entries: [] };
}

function integer(value, minimum, maximum, label) { // Rejects fractions, missing values, and values outside the field's technical bounds.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function validateTimestamp(value) { // Preserves the entry's original local day and explicit timezone offset.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(value)) {
    throw new Error('Each date must include a time and timezone offset.');
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = value.match(/\d+/g).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2100 || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Choose a valid date between 2000 and 2100.');
  }
  return value;
}

export function validateEntry(entry) { // Whitelists persisted fields so imported markup or extra properties never enter the interface.
  if (!entry || typeof entry !== 'object') throw new Error('The backup contains an invalid entry.');
  if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id)) throw new Error('An entry has an invalid ID.');
  if (entry.kind === 'diaper-change') { // A completed diaper is independent of individual wettings and roll outcomes.
    if (entry.edited !== undefined && typeof entry.edited !== 'boolean') throw new Error('Invalid edited flag.');
    return { id: entry.id, kind: 'diaper-change', occurredAt: validateTimestamp(entry.occurredAt),
      diaperNumber: integer(entry.diaperNumber, 1, 10000, 'Diaper number'), wettingsCount: integer(entry.wettingsCount, 0, 10000, 'Wettings before change'), edited: entry.edited ?? false };
  }
  if (entry.kind === 'observation') {
    if ((entry.position !== undefined && !POSITIONS.includes(entry.position)) || entry.liquidsMode !== 'interval') throw new Error('Invalid observation position or liquid measurement mode.');
    if (entry.edited !== undefined && typeof entry.edited !== 'boolean') throw new Error('Invalid edited flag.');
    return { id: entry.id, kind: 'observation', occurredAt: validateTimestamp(entry.occurredAt),
      liquidsMl: integer(entry.liquidsMl, 0, 1000000, 'Liquids'), liquidsMode: 'interval', ...(entry.position === undefined ? {} : { position: entry.position }),
      diaperNumber: integer(entry.diaperNumber, 1, 10000, 'Diaper number'),
      ...(entry.wettingsCount === undefined ? {} : { wettingsCount: integer(entry.wettingsCount, 0, 10000, 'Wettings') }), edited: entry.edited ?? false };
  }
  if (entry.kind === 'roll') {
    if (entry.source !== 'random' || !['pee', 'hold'].includes(entry.result) || entry.rolledResult !== entry.result || entry.rolledAt !== entry.occurredAt) throw new Error('Invalid independent roll.');
    if (entry.position !== undefined && !POSITIONS.includes(entry.position)) throw new Error('Choose a supported roll position.');
    return { id: entry.id, kind: 'roll', occurredAt: validateTimestamp(entry.occurredAt), probability: integer(entry.probability, 20, 80, 'Probability'),
      result: entry.result, source: 'random', rolledAt: entry.occurredAt, rolledResult: entry.result,
      ...(entry.position === undefined ? {} : { position: entry.position }) };
  }
  if (entry.kind === 'protocol') {
    if (entry.protocolVersion !== 1 || typeof entry.timeZone !== 'string' || entry.timeZone.length > 100) throw new Error('Invalid protocol settings.');
    try { new Intl.DateTimeFormat('en', { timeZone: entry.timeZone }).format(); } catch { throw new Error('Invalid protocol timezone.'); }
    return { id: entry.id, kind: 'protocol', occurredAt: validateTimestamp(entry.occurredAt), protocolVersion: 1, timeZone: entry.timeZone,
      ...(entry.lastFailureAt === undefined ? {} : { lastFailureAt: validateTimestamp(entry.lastFailureAt) }) };
  }
  if (entry.kind === 'wetting') {
    if (!WETTING_CATEGORIES.includes(entry.category) || !POSITIONS.includes(entry.position)) throw new Error('Choose a wetting category and position.');
    if (entry.edited !== undefined && typeof entry.edited !== 'boolean') throw new Error('Invalid edited flag.');
    return { id: entry.id, kind: 'wetting', occurredAt: validateTimestamp(entry.occurredAt), category: entry.category,
      position: entry.position, diaperNumber: integer(entry.diaperNumber, 1, 10000, 'Diaper number'), edited: entry.edited ?? false,
      ...(entry.wettingsCount === undefined ? {} : { wettingsCount: integer(entry.wettingsCount, 0, 10000, 'Wettings') }) };
  }
  if (entry.kind !== undefined) throw new Error('Unknown record kind. Update Little Log before reading this backup.');
  if (!POSITIONS.includes(entry.position)) throw new Error('Choose a supported position.');
  if (!['pee', 'hold'].includes(entry.result)) throw new Error('Result must be pee or hold.');
  if (!['random', 'manual'].includes(entry.source)) throw new Error('Entry source must be random or manual.');
  if (entry.edited !== undefined && typeof entry.edited !== 'boolean') throw new Error('Invalid edited flag.');
  if ((entry.rolledAt !== undefined || entry.rolledResult !== undefined) &&
      (entry.source !== 'random' || entry.rolledAt === undefined || !['pee', 'hold'].includes(entry.rolledResult))) throw new Error('Invalid original roll metadata.');
  return {
    id: entry.id,
    occurredAt: validateTimestamp(entry.occurredAt),
    liquidsMl: integer(entry.liquidsMl, 0, 1000000, 'Liquids'),
    position: entry.position,
    diaperNumber: integer(entry.diaperNumber, 1, 10000, 'Diaper number'),
    wettingsCount: integer(entry.wettingsCount, 0, 10000, 'Wettings'),
    probability: integer(entry.probability, 0, 100, 'Probability'),
    result: entry.result,
    source: entry.source,
    edited: entry.edited ?? false,
    ...(entry.rolledAt === undefined ? {} : { rolledAt: validateTimestamp(entry.rolledAt), rolledResult: entry.rolledResult }),
  };
}

export function validateState(value) { // Validates a complete backup before allowing any part of it to replace local state.
  if (!value || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new Error('Use a Little Log version 1 JSON backup with at most 50,000 entries.');
  }
  if (!value.settings || !POSITIONS.includes(value.settings.position)) throw new Error('The backup has invalid settings.');
  const entries = value.entries.map(validateEntry);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('The backup contains duplicate entry IDs.');
  return {
    version: 1,
    settings: { probability: integer(value.settings.probability, 0, 100, 'Default probability'), position: value.settings.position },
    entries,
  };
}

const pad = value => String(value).padStart(2, '0'); // Pads date components without relying on browser locale formatting.

export function localDay(date = new Date()) { // Produces a calendar key in the device's current timezone.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localInput(date = new Date()) { // Supplies the minute-precision value expected by datetime-local controls.
  return `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function timestampFromInput(value) { // Attaches the offset for the selected date, including its daylight-saving rules.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a valid date and time.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localInput(date) !== value) throw new Error('That local time does not exist. Choose another time.');
  const offset = -date.getTimezoneOffset();
  return validateTimestamp(`${value}:00${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`);
}

export function rollResult(probability, random = () => crypto.getRandomValues(new Uint32Array(1))[0]) { // Uses rejection sampling to give all 100 integer outcomes exactly equal weight.
  integer(probability, 0, 100, 'Probability');
  if (probability === 0) return 'hold';
  if (probability === 100) return 'pee';
  const limit = 4294967200; // Largest multiple of 100 below 2^32; rejects the remaining 96 values.
  let draw;
  do {
    draw = random();
    integer(draw, 0, 4294967295, 'Random draw');
  } while (draw >= limit);
  return draw % 100 < probability ? 'pee' : 'hold';
}

export function sortedEntries(entries) { // Orders by actual instant; reverse insertion order breaks same-minute ties.
  return [...entries].reverse().sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

export function liquidTotal(entries) { // Adds interval intake after the last legacy cumulative snapshot, avoiding overlap with that snapshot.
  const legacy = entries.filter(entry => entry.kind === undefined);
  const cutoff = Math.max(-Infinity, ...legacy.map(entry => Date.parse(entry.occurredAt)));
  return Math.max(0, ...legacy.map(entry => entry.liquidsMl)) + entries.filter(entry => entry.kind === 'observation' && Date.parse(entry.occurredAt) > cutoff).reduce((sum, entry) => sum + entry.liquidsMl, 0);
}

export function daySummary(entries, day) { // Keeps check-in counts, random outcomes, and intake measurements independent.
  const dayEntries = entries.filter(entry => entry.occurredAt.slice(0, 10) === day);
  const matches = sortedEntries(dayEntries.filter(isObservation));
  const rolls = dayEntries.filter(isRoll);
  return {
    count: matches.length,
    pee: rolls.filter(entry => entry.result === 'pee').length,
    hold: rolls.filter(entry => entry.result === 'hold').length,
    liquidsMl: liquidTotal(dayEntries),
    latest: matches[0] ?? null,
  };
}

export function dailySeries(entries, length, today = new Date()) { // Walks calendar days at noon so DST changes cannot duplicate or skip dates.
  integer(length, 1, 366, 'Chart days');
  const grouped = new Map();
  for (const entry of entries) {
    if (!isRoll(entry) && !isObservation(entry)) continue;
    const day = entry.occurredAt.slice(0, 10);
    const totals = grouped.get(day) ?? { pee: 0, hold: 0, entries: [] };
    if (isRoll(entry)) totals[entry.result] += 1;
    totals.entries.push(entry);
    grouped.set(day, totals);
  }
  return Array.from({ length }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - length + index + 1, 12);
    const day = localDay(date);
    const totals = grouped.get(day);
    return { day, pee: totals?.pee ?? 0, hold: totals?.hold ?? 0, liquidsMl: liquidTotal(totals?.entries ?? []) };
  });
}

export function mergeBackup(current, incoming) { // Adds new IDs, skips identical entries, and rejects conflicting IDs to prevent silent data loss.
  const clean = validateState(incoming);
  const existing = new Map(current.entries.map(entry => [entry.id, entry]));
  const additions = [];
  for (const entry of clean.entries) {
    if (!existing.has(entry.id)) additions.push(entry);
    else if (JSON.stringify(validateEntry(existing.get(entry.id))) !== JSON.stringify(entry)) {
      throw new Error('This backup has a changed version of an existing entry. Nothing was imported; keep both backups for comparison.');
    }
  }
  return { state: validateState({ ...current, entries: [...current.entries, ...additions] }), added: additions.length };
}

export function toCsv(entries) { // Exports all selected snapshots with explicit units, offsets, provenance, and escaped CSV cells.
  const columns = ['occurredAt', 'liquidsMl', 'position', 'diaperNumber', 'wettingsCount', 'probability', 'result', 'source', 'edited', 'kind', 'category', 'rolledAt', 'rolledResult', 'protocolVersion', 'timeZone', 'lastFailureAt', 'liquidsMode'];
  const escape = value => `"${String(value).replaceAll('"', '""')}"`;
  return '\uFEFF' + [columns, ...sortedEntries(entries).map(entry => columns.map(key => key === 'kind' ? entry.kind ?? 'roll' : key === 'liquidsMode' && entry.kind === undefined ? 'cumulative' : entry[key] ?? ''))]
    .map(row => row.map(escape).join(',')).join('\r\n');
}
