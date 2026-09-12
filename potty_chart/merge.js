/* Shared by the browser sync client and its tests. Merge edits against their last acknowledged chart. */
globalThis.mergeGrowthCharts = function ({base, local, remote, initial=false}) {
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const choose=(key,b,l,r)=>equal(l?.[key],b?.[key])?r?.[key]:l?.[key]; // A pending local edit wins a simultaneous edit to the same field.
  const original=new Map(base.rows.map(row=>[row.id,row])), server=new Map(remote.rows.map(row=>[row.id,row]));
  const device=structuredClone(local), remapped=new Map();
  if(initial) for(const row of device.rows) {
    const other=server.get(row.id), previous=original.get(row.id);
    const meaningful=!equal(row,previous) || Object.keys(device.stars).some(key=>key.endsWith(':'+row.id));
    if(row.id==='potty' || !other || !meaningful || (row.label===other.label && row.note===other.note)) continue;
    const oldId=row.id;
    let hash=2166136261;
    for(const ch of JSON.stringify([row.id,row.label,row.note])) hash=Math.imul(hash^ch.charCodeAt(0),16777619)>>>0;
    let id='merged-'+hash.toString(16),suffix=0;
    while(server.has(id) || device.rows.some(value=>value.id===id)) id='merged-'+hash.toString(16)+'-'+(++suffix);
    row.id=id; remapped.set(oldId,id); // Unrelated guest rows retain separate identities so stars cannot acquire the wrong meaning.
  }
  if(remapped.size) device.stars=Object.fromEntries(Object.entries(device.stars).map(([key,value])=>{
    const [day,id]=key.split(':'); return [day+':'+(remapped.get(id)??id),value];
  }));
  const localRows=new Map(device.rows.map(row=>[row.id,row])), rows=[];
  for(const id of new Set([...server.keys(),...localRows.keys()])) {
    const b=original.get(id),l=localRows.get(id),r=server.get(id);
    if(!initial && !l && b && (!r || equal(r,b))) continue; // Keep deliberate removals when the other copy has not edited that row.
    if(!r && b && (!l || equal(l,b))) continue;
    if(!l || !r) { rows.push(structuredClone(l??r)); continue; }
    const row={id};
    for(const key of ['label','note','praise','locked']) {
      const value=choose(key,b,l,r); if(value!==undefined) row[key]=value;
    }
    rows.push(row);
  }
  const rowIds=new Set(rows.map(row=>row.id)),stars={};
  for(const key of new Set([...Object.keys(base.stars),...Object.keys(device.stars),...Object.keys(remote.stars)])) {
    const keep=Boolean(device.stars[key])===Boolean(base.stars[key])?remote.stars[key]:device.stars[key];
    if(keep && rowIds.has(key.split(':')[1])) stars[key]=true; // Merge independent additions and removals by date plus stable row ID.
  }
  if(rows.length>16 || Object.keys(stars).length>7000) throw Error('These charts exceed the saved-chart limit when combined. Both copies are retained; reduce unused rows or export a backup before retrying.');
  const refusals=initial?Math.max(device.refusals,remote.refusals):device.refusals<base.refusals?device.refusals:remote.refusals<base.refusals?remote.refusals:base.refusals+(device.refusals-base.refusals)+(remote.refusals-base.refusals);
  return {name:initial?(remote.name||device.name):choose('name',base,device,remote),rows,stars,refusals,
    escaped:initial?(device.escaped||remote.escaped):choose('escaped',base,device,remote),
    since:initial?[device.since,remote.since].sort()[0]:choose('since',base,device,remote)};
};
