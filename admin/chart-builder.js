import {CHART_METRICS,CHART_COLORS,chartSettings,buildXY,xyCsv} from '../lib/chart-builder-model.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number(value.toFixed(2)).toLocaleString();
export function renderChartSvg(chart) { // Inline geometry, text, colors and background make SVG/PNG exports self-contained.
 const width=1100,height=490+Math.ceil(chart.series.length/2)*28,left=84,right=38,top=105,bottom=355,pw=width-left-right,ph=bottom-top;
 const lines=chart.series.map(s=>({...s,points:s.points.slice(-1000)})),valid=lines.flatMap(s=>s.points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 const xs=valid.map(p=>p.x),ys=valid.map(p=>p.y);let xmin=chart.settings.x==='period'?Math.min(...xs):Math.min(0,...xs),xmax=Math.max(...xs),ymin=chart.settings.scale==='raw'&&chart.settings.y.every(id=>id==='action')?1:0,ymax=chart.settings.scale==='normalized'?100:ymin===1?5:Math.max(1,...ys);
 if(!valid.length){xmin=0;xmax=1;}if(xmax===xmin){xmin-=chart.settings.x==='period'?43200000:.5;xmax+=chart.settings.x==='period'?43200000:.5;}
 const x=n=>left+12+(n-xmin)/(xmax-xmin)*(pw-24),y=n=>bottom-(n-ymin)/(ymax-ymin)*ph;
 const text=(px,py,value,extra='')=>'<text x="'+px+'" y="'+py+'" fill="#efdce9" font-family="Arial,sans-serif" font-size="13" '+extra+'>'+escape(value)+'</text>';
 let svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+escape(chart.settings.title)+'"><title>'+escape(chart.settings.title)+'</title><rect width="100%" height="100%" rx="18" fill="#260b20"/>';
 svg+=text(left,32,chart.settings.title||'My statistics','font-weight="bold"')+text(left,55,chart.filters.interval+' groups | '+(chart.filters.from||'first record')+' to '+(chart.filters.to||'latest record')+' | '+(chart.settings.split==='participant'?'separate participant lines':'selected participants combined'));
 const cohort=chart.participants.length===1?chart.participants[0].label+' / '+chart.participants[0].id.slice(0,8):chart.participants.length+' selected participants';
 svg+=text(left,77,cohort.length>110?cohort.slice(0,107)+'...':cohort);
 for(let i=0;i<=4;i++){const value=ymin+(ymax-ymin)*i/4;svg+='<path d="M'+left+' '+y(value)+'H'+(width-right)+'" stroke="#65405a" stroke-dasharray="4 5"/>'+text(left-12,y(value)+5,number(value),'text-anchor="end"');}
 for(let i=0;i<=4;i++){const value=xmin+(xmax-xmin)*i/4;svg+=text(x(value),bottom+27,chart.settings.x==='period'&&valid.length?new Date(value).toISOString().slice(0,10):number(value),'text-anchor="middle"');}
 svg+=text(left+pw/2,bottom+57,chart.xLabel,'text-anchor="middle"');
 const units=[...new Set(chart.series.map(s=>s.unit))].join(', '),axis=chart.settings.scale==='normalized'?'Normalized per line (0-100)':units.length>36?'Raw values (units in legend)':'Raw values ('+units+')';
 svg+=text(0,0,axis,'transform="translate(21 '+(top+ph/2)+') rotate(-90)" text-anchor="middle"');
 for(const series of lines){let segments=[[]];for(const point of series.points){if(!Number.isFinite(point.x)||!Number.isFinite(point.y)){segments.push([]);continue;}if(point.breakBefore)segments.push([]);segments.at(-1).push(x(point.x)+','+y(point.y));}
  svg+=segments.filter(s=>s.length>1).map(s=>'<polyline points="'+s.join(' ')+'" fill="none" stroke="'+series.color+'" stroke-width="2.5"/>').join('');
  svg+=series.points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).map(p=>'<circle cx="'+x(p.x)+'" cy="'+y(p.y)+'" r="3.5" fill="'+series.color+'"><title>'+escape(series.label+' | '+p.period+' | X: '+(chart.settings.x==='period'?p.period:number(p.x))+' | Y: '+number(p.rawY)+' '+series.unit)+'</title></circle>').join('');
 }
 if(!valid.length)svg+=text(left+pw/2,top+ph/2,'No matching numeric pairs. Try another statistic or date range.','text-anchor="middle"');
 chart.series.forEach((series,i)=>{const px=left+(i%2)*485,py=445+Math.floor(i/2)*28,label=series.label+' ('+series.unit+')';svg+='<path d="M'+px+' '+py+'h22" stroke="'+series.color+'" stroke-width="3"/>'+text(px+30,py+4,label.length>55?label.slice(0,52)+'...':label);});
 return svg+'</svg>';
}
export function createChartBuilder(root) { // Keep authorized chart data in memory; only explicitly saved presentation presets use browser storage.
 const $=selector=>root.querySelector(selector),key='little-log.chart-presets.v1';let source=null,filters={},chart=null,epoch=0;
 const status=message=>{$('#builder-status').textContent=message;};
 $('#builder-x').innerHTML='<option value="period">Recorded day / week / month</option>'+CHART_METRICS.map(m=>'<option value="'+m.id+'">'+escape(m.label+' ('+m.unit+')')+'</option>').join('');
 $('#builder-metrics').innerHTML=CHART_METRICS.map((m,i)=>'<div class="builder-metric"><label><input type="checkbox" value="'+m.id+'" '+(['wettings','changes'].includes(m.id)?'checked':'')+'> '+escape(m.label)+' <small>('+m.unit+')</small></label><input type="color" data-color="'+m.id+'" value="'+CHART_COLORS[i%CHART_COLORS.length]+'" aria-label="Color for '+escape(m.label)+'"></div>').join('');
 function config(){return chartSettings({title:$('#builder-title').value,x:$('#builder-x').value,y:[...root.querySelectorAll('#builder-metrics input:checked')].map(e=>e.value),split:$('#builder-split').value,scale:$('#builder-scale').value,colors:Object.fromEntries([...root.querySelectorAll('[data-color]')].map(e=>[e.dataset.color,e.value]))});}
 function apply(input){const settings=chartSettings(input);$('#builder-title').value=settings.title;$('#builder-x').value=settings.x;$('#builder-split').value=settings.split;$('#builder-scale').value=settings.scale;for(const input of root.querySelectorAll('#builder-metrics input[type="checkbox"]'))input.checked=settings.y.includes(input.value);for(const input of root.querySelectorAll('[data-color]'))if(settings.colors[input.dataset.color])input.value=settings.colors[input.dataset.color];}
 function render(){epoch++;chart=null;$('#builder-plot').replaceChildren();$('#builder-table').replaceChildren();for(const e of root.querySelectorAll('[data-builder-export]'))e.disabled=true;if(!source)return;
  try{chart=buildXY(source,config(),filters);$('#builder-plot').innerHTML=renderChartSvg(chart);
   const columns=['Participant','Period',chart.xLabel,...chart.settings.y.map(id=>{const m=CHART_METRICS.find(m=>m.id===id);return m.label+' ('+m.unit+')';})],rows=chart.rows.slice(0,100);
   $('#builder-table').innerHTML='<table><thead><tr>'+columns.map(c=>'<th scope="col">'+escape(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+[r.participant,r.period,r.x,...chart.settings.y.map(id=>r.values[id])].map(v=>'<td>'+escape(v===null?'Not recorded':typeof v==='number'?number(v):v)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
   for(const e of root.querySelectorAll('[data-builder-export]'))e.disabled=false;
   status(chart.series.length+' colored lines; '+chart.rows.length+' period rows. Table shows up to 100 rows; CSV/JSON include all rows. '+(chart.series.some(s=>s.points.length>1000)?'Plot/images show the last 1,000 points per line. ':'')+(chart.settings.scale==='normalized'?'Each line maps its minimum to 0 and maximum to 100; constant lines sit at 50. Exports retain raw values.':'Raw units are shown in the legend. Use Normalize when comparing different units.'));
  }catch(error){chart=null;status(error.message);}
 }
 function presets(){try{const data=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(data))return [];return data.slice(0,30).flatMap(p=>{try{return typeof p.name==='string'&&p.name.length<=60?[{name:p.name,settings:chartSettings(p.settings)}]:[];}catch{return [];}});}catch{return [];}}
 function refreshPresets(){const selected=$('#builder-presets').value;$('#builder-presets').replaceChildren(new Option('Choose a saved chart',''),...presets().map(p=>new Option(p.name,p.name)));$('#builder-presets').value=selected;}
 function download(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
 root.addEventListener('change',event=>{if(event.target.closest('#builder-metrics')||['builder-x','builder-split','builder-scale','builder-title'].includes(event.target.id))render();});
 $('#builder-presets').addEventListener('change',()=>{const preset=presets().find(p=>p.name===$('#builder-presets').value);if(preset){apply(preset.settings);$('#builder-preset-name').value=preset.name;render();}});
 $('#builder-save').addEventListener('click',()=>{try{const name=$('#builder-preset-name').value.trim();if(!name)throw Error('Give this chart setup a name first.');const list=presets().filter(p=>p.name!==name);if(list.length>=30)throw Error('Delete a saved chart before adding another (30 maximum).');list.push({name,settings:config()});localStorage.setItem(key,JSON.stringify(list));refreshPresets();$('#builder-presets').value=name;status('Chart setup saved in this browser. Participant records and filters were not stored.');}catch(error){status('Could not save chart setup: '+error.message);}});
 $('#builder-delete').addEventListener('click',()=>{try{const name=$('#builder-presets').value;if(!name)return;localStorage.setItem(key,JSON.stringify(presets().filter(p=>p.name!==name)));refreshPresets();status('Saved chart setup removed.');}catch{status('Browser storage is unavailable.');}});
 root.addEventListener('click',async event=>{const button=event.target.closest('[data-builder-export]');if(!button||!chart)return;const current=chart,version=epoch,type=button.dataset.builderExport;
  try{
   if(type==='csv')download('little-log-custom-chart.csv',new Blob(['\uFEFF'+xyCsv(current)],{type:'text/csv;charset=utf-8'}));
   if(type==='json')download('little-log-custom-chart.json',new Blob([JSON.stringify({format:'little-log-chart',version:1,...current},null,2)],{type:'application/json'}));
   if(type==='svg')download('little-log-custom-chart.svg',new Blob([renderChartSvg(current)],{type:'image/svg+xml'}));
   if(type==='png'){button.disabled=true;status('Preparing high-resolution PNG...');const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(renderChartSvg(current));await image.decode();if(version!==epoch)return;const canvas=document.createElement('canvas');canvas.width=image.width*2;canvas.height=image.height*2;canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));if(version!==epoch)return;if(!blob)throw Error('The browser could not create the image.');download('little-log-custom-chart.png',blob);status('PNG saved at '+canvas.width+' x '+canvas.height+' pixels.');}
  }catch(error){if(version===epoch)status('Export failed: '+error.message);}finally{if(version===epoch)button.disabled=false;}
 });
 refreshPresets();
 return {update(dataset,options){source=dataset;filters=options;render();},clear(){source=null;chart=null;epoch++;$('#builder-plot').replaceChildren();$('#builder-table').replaceChildren();status('Sign in as an administrator to load chart data.');for(const button of root.querySelectorAll('[data-builder-export]'))button.disabled=true;}};
}
