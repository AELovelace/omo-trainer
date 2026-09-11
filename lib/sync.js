import { validateState, validateEntry } from './model.js';

export const emptySync = () => ({ participant: null, versions: [], queue: [], conflicts: [], lastSyncedAt: null }); // Keeps sync metadata in the same atomic local write as the records it describes.
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

export function validateRecord(record) { // Rejects malformed remote versions before applying any downloaded records.
  if (!record || !validId(record.id) || !Number.isSafeInteger(record.version) || record.version < 0) throw new Error('Invalid server record.');
  const entry = record.entry === null ? null : validateEntry(record.entry);
  if (entry && entry.id !== record.id) throw new Error('Server record IDs do not match.');
  return { id: record.id, version: record.version, entry };
}

export function deviceState(value) { // Reads old local-only backups and the new durable sync envelope without accepting credentials from imports.
  const clean = validateState(value);
  const sync = value.sync ?? emptySync();
  if (sync.participant !== null && (!validId(sync.participant?.id) || typeof sync.participant.label !== 'string' || sync.participant.label.length > 80)) throw new Error('Invalid saved account.');
  if (![sync.versions, sync.queue, sync.conflicts].every(Array.isArray)) throw new Error('Invalid saved sync state.');
  const versions = sync.versions.map(record => {
    if (!validId(record.id) || !Number.isSafeInteger(record.version) || record.version < 0) throw new Error('Invalid saved version.');
    return { id: record.id, version: record.version };
  });
  const queue = sync.queue.map(change => {
    if (!validId(change.mutationId)) throw new Error('Invalid saved change.');
    const record = validateRecord({ id: change.id, version: change.baseVersion, entry: change.entry });
    return { mutationId: change.mutationId, id: record.id, baseVersion: record.version, entry: record.entry };
  });
  const conflicts = sync.conflicts.map(conflict => ({ ...validateRecord(conflict), local: conflict.local === null ? null : validateEntry(conflict.local) }));
  return { ...clean, sync: { participant: sync.participant, versions, queue, conflicts, lastSyncedAt: typeof sync.lastSyncedAt === 'string' ? sync.lastSyncedAt : null } };
}

export function queueChanges(current, next, makeId = () => crypto.randomUUID()) { // Saves each edit/deletion as a retryable mutation without confusing an unsent edit with a remote update.
  const sync = structuredClone(current.sync ?? emptySync());
  if (!sync.participant) return { ...validateState(next), sync };
  const before = new Map(current.entries.map(entry => [entry.id, entry]));
  const after = new Map(next.entries.map(entry => [entry.id, entry]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const entry = after.get(id) ?? null;
    if (same(before.get(id) ?? null, entry)) continue;
    const conflict = sync.conflicts.find(record => record.id === id);
    if (conflict) { conflict.local = entry; continue; } // Keeps subsequent local corrections inside an unresolved conflict for explicit review.
    const pending = sync.queue.filter(change => change.id === id).at(-1);
    const baseVersion = pending ? pending.baseVersion + 1 : sync.versions.find(record => record.id === id)?.version ?? 0;
    sync.queue.push({ mutationId: makeId(), id, baseVersion, entry });
  }
  return deviceState({ ...next, sync });
}

export function reconcile(current, response) { // Acknowledges retries and merges snapshots while preserving every unsent local edit and deletion.
  if (!Array.isArray(response.records) || !Array.isArray(response.ack) || !Array.isArray(response.conflicts)) throw new Error('Invalid sync response.');
  const remote = response.records.map(validateRecord);
  if (new Set(remote.map(record => record.id)).size !== remote.length) throw new Error('Duplicate server records.');
  const sync = structuredClone(current.sync);
  const knownVersions = new Map(sync.versions.map(record => [record.id, record.version]));
  const ack = new Set(response.ack);
  sync.queue = sync.queue.filter(change => !ack.has(change.mutationId));
  const local = new Map(current.entries.map(entry => [entry.id, entry]));
  for (const value of response.conflicts) {
    const conflict = validateRecord(value);
    if (conflict.version < (knownVersions.get(conflict.id) ?? 0)) continue;
    sync.queue = sync.queue.filter(change => change.id !== conflict.id);
    sync.conflicts = sync.conflicts.filter(record => record.id !== conflict.id);
    sync.conflicts.push({ ...conflict, local: local.get(conflict.id) ?? null });
  }
  const protectedIds = new Set([...sync.queue, ...sync.conflicts].map(record => record.id));
  for (const record of remote) {
    if (record.version < (knownVersions.get(record.id) ?? 0)) continue; // A delayed response from another tab must never roll a newer acknowledged record backward.
    knownVersions.set(record.id, record.version);
    if (!protectedIds.has(record.id)) {
      if (record.entry) local.set(record.id, record.entry);
      else local.delete(record.id);
    }
  }
  sync.versions = [...knownVersions].map(([id, version]) => ({ id, version }));
  sync.lastSyncedAt = new Date().toISOString();
  return deviceState({ ...current, entries: [...local.values()], sync });
}

export function connectAccount(current, participant, records, makeId = () => crypto.randomUUID()) { // Requires the same account on reconnect and explicitly migrates old local-only entries on first connection.
  if (current.sync?.participant && current.sync.participant.id !== participant.id) throw new Error('This device has records for another account. Sign out and clear its device copy before connecting a different account.');
  const next = deviceState({ ...current, sync: current.sync ?? emptySync() });
  if (!next.sync.participant) {
    next.sync.participant = participant;
    const byId = new Map(records.map(record => [record.id, validateRecord(record)]));
    next.sync.queue = next.entries.filter(entry => !same(entry, byId.get(entry.id)?.entry)).map(entry => ({ mutationId: makeId(), id: entry.id, baseVersion: 0, entry }));
  }
  return reconcile(next, { records, ack: [], conflicts: [] });
}

export function resolveConflict(current, id, useLocal, makeId = () => crypto.randomUUID()) { // Replaces a conflicting version only after the person chooses which copy to keep.
  const next = deviceState(current);
  const conflict = next.sync.conflicts.find(record => record.id === id);
  if (!conflict) throw new Error('This conflict is no longer pending.');
  next.sync.conflicts = next.sync.conflicts.filter(record => record.id !== id);
  const entry = useLocal ? conflict.local : conflict.entry;
  next.entries = next.entries.filter(value => value.id !== id);
  if (entry) next.entries.push(entry);
  if (useLocal) next.sync.queue.push({ mutationId: makeId(), id, baseVersion: conflict.version, entry });
  return next;
}
