const ROW_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function calendarDate(value) { // Reject impossible dates before they affect chart history.
  return typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validateGrowthChart(input) { // Store only the bounded chart document, never credentials or browser sync metadata.
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid chart.');
  if (typeof input.name !== 'string' || input.name.length > 24 || !calendarDate(input.since)) throw new Error('Invalid chart name or start date.');
  if (!Number.isSafeInteger(input.refusals) || input.refusals < 0 || typeof input.escaped !== 'boolean') throw new Error('Invalid chart progress.');
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 16) throw new Error('A chart needs 1?16 rows.');
  const ids = new Set();
  const rows = input.rows.map(row => {
    if (!row || typeof row.id !== 'string' || !ROW_ID.test(row.id) || ids.has(row.id)) throw new Error('Invalid or duplicate row ID.');
    ids.add(row.id);
    if (typeof row.label !== 'string' || !row.label.trim() || row.label.length > 48 || typeof row.note !== 'string' || row.note.length > 72 || (row.praise !== undefined && (typeof row.praise !== 'string' || row.praise.length > 512))) throw new Error('Invalid row text.');
    return { id: row.id, label: row.label, note: row.note, ...(row.praise === undefined ? {} : { praise: row.praise }), locked: row.id === 'potty' };
  });
  if (!ids.has('potty')) throw new Error('The locked chart row must remain.');
  if (!input.stars || typeof input.stars !== 'object' || Array.isArray(input.stars) || Object.keys(input.stars).length > 7000) throw new Error('Invalid stars or chart storage limit exceeded.');
  const stars = {};
  for (const [key, value] of Object.entries(input.stars)) {
    const [date, rowId, extra] = key.split(':');
    if (!calendarDate(date) || !ids.has(rowId) || rowId === 'potty' || extra !== undefined || value !== true) throw new Error('Invalid star date or row.');
    stars[key] = true;
  }
  return { name: input.name, stars, rows, refusals: input.refusals, escaped: input.escaped, since: input.since };
}
