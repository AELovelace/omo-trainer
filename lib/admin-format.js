// Shared export format keeps participant ownership and user-authored chart row definitions intact.
export const ENTRY_FIELDS = ['id','kind','occurredAt','liquidsMl','liquidsMode','position','diaperNumber','wettingsCount','probability','result','source','edited','category','rolledAt','rolledResult','protocolVersion','timeZone','lastFailureAt','desperation','baseProbability','probabilityModifier','rollRuleVersion'];
export const CSV_COLUMNS = ['participant_id','participant_label','record_type',...ENTRY_FIELDS,'chart_name','chart_since','chart_refusals','chart_escaped','rows_json','stars_json'];
const numeric = new Set(['liquidsMl','diaperNumber','wettingsCount','probability','protocolVersion','baseProbability','rollRuleVersion']);

export function datasetCsv(dataset) { // Quote every cell and neutralize spreadsheet formulas without losing original text on reimport.
  const cell = value => {
    const text = String(value ?? '');
    const safe = /^[=+\-@\t\r\n']/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"','""') + '"';
  };
  const rows = [];
  for (const user of dataset.users) {
    const owner = { participant_id:user.id, participant_label:user.label };
    rows.push({ ...owner, record_type:'participant' });
    for (const record of user.records) if (record.entry) rows.push({ ...owner, record_type:'entry', ...record.entry, kind:record.entry.kind ?? 'legacy' });
    if (user.growthChart?.chart) {
      const c = user.growthChart.chart;
      rows.push({ ...owner, record_type:'chart', chart_name:c.name, chart_since:c.since, chart_refusals:c.refusals,
        chart_escaped:c.escaped, rows_json:JSON.stringify(c.rows), stars_json:JSON.stringify(c.stars) });
    }
  }
  return '\uFEFF' + [CSV_COLUMNS,...rows.map(row=>CSV_COLUMNS.map(key=>row[key]))].map(row=>row.map(cell).join(',')).join('\r\n');
}

export function parseCsv(text) { // Parse quoted commas, CRLF, embedded newlines and doubled quotes; reject malformed or oversized tables.
  text = text.replace(/^\uFEFF/,'');
  const rows=[]; let row=[], value='', quoted=false, closed=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) {
      if (ch==='"' && text[i+1]==='"') { value+='"'; i++; }
      else if (ch==='"') { quoted=false; closed=true; }
      else value+=ch;
    } else if (ch==='"' && value==='' && !closed) quoted=true;
    else if (ch===',' || ch==='\n' || ch==='\r') {
      row.push(value); value=''; closed=false;
      if (ch!==',') { if (ch==='\r' && text[i+1]==='\n') i++; rows.push(row); row=[]; }
    } else {
      if (closed || ch==='"') throw Error('Malformed CSV quoting.');
      value+=ch;
    }
    if (row.length>100 || rows.length>100001) throw Error('CSV exceeds 100,000 rows or 100 columns.');
  }
  if (quoted) throw Error('CSV has an unclosed quoted cell.');
  if (value || closed || row.length) { row.push(value); rows.push(row); }
  if (!rows.length) throw Error('CSV is empty.');
  const columns=rows.shift();
  if (new Set(columns).size!==columns.length) throw Error('CSV contains duplicate columns.');
  const adminFormat=columns.includes('record_type');
  return rows.filter(row=>row.some(Boolean)).map(row=>{
    if (row.length!==columns.length) throw Error('CSV row has the wrong number of columns.');
    return Object.fromEntries(columns.map((key,i)=>[key,adminFormat && /^'[=+\-@\t\r\n']/.test(row[i]) ? row[i].slice(1) : row[i]]));
  });
}

export function csvEntry(row) { // Accept the web export and the operator's snake_case export while preserving legacy cumulative semantics.
  const aliases={ entry_id:'id', occurred_at:'occurredAt', liquids_ml:'liquidsMl', diaper_number:'diaperNumber', wettings_count:'wettingsCount',
    rolled_at:'rolledAt', rolled_result:'rolledResult', protocol_version:'protocolVersion', time_zone:'timeZone', last_failure_at:'lastFailureAt', liquids_mode:'liquidsMode', base_probability:'baseProbability', probability_modifier:'probabilityModifier', roll_rule_version:'rollRuleVersion' };
  const input={...row};
  for(const [from,to] of Object.entries(aliases)) if(input[to]===undefined && input[from]!==undefined) input[to]=input[from];
  const entry={};
  for(const key of ENTRY_FIELDS) if(input[key]!==undefined && input[key]!=='' && input[key]!==null) {
    if(numeric.has(key)) entry[key]=Number(input[key]);
    else if(key==='edited') {
      if(!['true','false','1','0',true,false,0,1].includes(input[key])) throw Error('Invalid CSV edited flag.');
      entry[key]=input[key]===true || input[key]==='true' || input[key]==='1' || input[key]===1;
    } else entry[key]=input[key];
  }
  if(entry.kind==='legacy' || (entry.kind==='roll' && (entry.liquidsMode==='cumulative' || entry.source==='manual' || entry.liquidsMl!==undefined))) delete entry.kind;
  return entry;
}
