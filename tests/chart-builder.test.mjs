import test from 'node:test';import assert from 'node:assert/strict';
import {buildXY,chartSettings,xyCsv,CHART_METRICS} from '../lib/chart-builder-model.js';import {renderChartSvg} from '../admin/chart-builder.js';import {parseCsv} from '../lib/admin-format.js';
const wet=(id,day,hour,category='voluntary')=>({id,kind:'wetting',occurredAt:day+'T'+hour+':00:00+00:00',category,position:'sitting',diaperNumber:1});
const obs=(id,day,ml)=>({id,kind:'observation',occurredAt:day+'T08:00:00+00:00',liquidsMl:ml,liquidsMode:'interval',diaperNumber:1});
const user=(id,entries)=>({id,label:'Same name',records:entries.map(entry=>({entry}))});
const a=user('alice',[wet('previous','2026-09-01','23'),obs('drink','2026-09-02',100),wet('one','2026-09-02','01','forced'),wet('two','2026-09-02','03','involuntary'),obs('dry','2026-09-04',0)]);
const b=user('bob',[obs('drink','2026-09-02',200),wet('other','2026-09-02','12'),{id:'roll',kind:'roll',occurredAt:'2026-09-02T13:00:00+00:00',probability:50,result:'hold',rolledResult:'hold',source:'random',desperation:'medium'}]);
test('XY pairs preserve original period units, interval sample counts, missing intake and separate users',()=>{
 const chart=buildXY({users:[a,b]},{x:'liquids',y:['wettings','action','interval','medium']},{from:'2026-09-02'});
 assert.deepEqual(chart.rows.map(r=>[r.period,r.x,r.values.wettings,r.values.action,r.values.interval,r.intervalSamples,r.values.medium]),[['2026-09-02',300,3,3,120,2,1],['2026-09-04',0,0,null,null,0,0]]);
 const split=buildXY({users:[a,b]},{y:['wettings'],split:'participant'});assert.equal(split.series.length,2);assert.notEqual(split.series[0].id,split.series[1].id);assert.notEqual(split.series[0].color,split.series[1].color);
 assert.equal(split.rows.find(r=>r.participantId==='alice'&&r.period==='2026-09-01').values.wettings,1);
 const missing=buildXY({users:[a]},{x:'liquids',y:['wettings']});assert.equal(missing.rows[0].x,null,'Unlogged intake is not zero');
});
test('normalized points do not mutate raw exports and constant series stay at 50',()=>{
 const chart=buildXY({users:[a]},{y:['wettings','liquids'],scale:'normalized'});const series=chart.series.find(s=>s.id.endsWith(':wettings'));assert.deepEqual(series.points.map(p=>p.y),[50,100,0]);assert.deepEqual(series.points.map(p=>p.rawY),[1,2,0]);
 const one=buildXY({users:[b]},{y:['wettings'],scale:'normalized'});assert.equal(one.series[0].points[0].y,50);
 const csv=xyCsv(chart);assert.ok(csv.includes('\r\n'));assert.equal(parseCsv(xyCsv(buildXY({users:[a]},{x:'liquids',y:['liquids']}))).length,3);assert.equal(parseCsv(csv).length,3);assert.equal(chart.rows[1].values.liquids,100);
});
test('calendar groups retain weighted means, mark gaps, and numeric X sorting is explicit',()=>{
 const chart=buildXY({users:[a]},{y:['action']});assert.equal(chart.series[0].points[2].breakBefore,true);
 const month=buildXY({users:[a,b]},{y:['action','wettings']},{interval:'month'});assert.equal(month.rows.length,1);assert.equal(month.rows[0].values.action,3);assert.equal(month.rows[0].values.wettings,4);
 const numeric=buildXY({users:[a]},{x:'liquids',y:['wettings']});assert.deepEqual(numeric.series[0].points.map(p=>p.x),[0,100,null]);
 const svg=renderChartSvg(chart);assert.ok(!/NaN|Infinity/.test(svg));assert.match(svg,/Raw values \(1-5\)/);assert.equal((svg.match(/<polyline /g)||[]).length,1);
});
test('settings are allowlisted, series bounds enforced, and all selectable metrics can render',()=>{
 assert.throws(()=>chartSettings({y:[]}),/one and six/);assert.throws(()=>buildXY({users:Array.from({length:13},(_,i)=>user('u'+i,[]))},{split:'participant',y:['wettings']}),/12 lines/);
 const settings=chartSettings({y:['wettings'],colors:{wettings:'#123456'},records:['private'],participantId:'alice'});assert.equal(settings.colors.wettings,'#123456');assert.equal(settings.records,undefined);assert.equal(settings.participantId,undefined);
 for(const metric of CHART_METRICS){const chart=buildXY({users:[a,b]},{x:metric.id,y:[metric.id]});assert.ok(!/NaN|Infinity/.test(renderChartSvg(chart)),metric.id);}
});
test('CSV cells and SVG labels escape untrusted participant labels and chart titles',()=>{
 const evil={...b,label:'=SUM(A1:A2), "name"'};const chart=buildXY({users:[evil]},{y:['wettings'],split:'participant',title:'<script>alert(1)</script>'});
 assert.match(xyCsv(chart),/'=SUM/);assert.ok(!renderChartSvg(chart).includes('<script>'));assert.ok(renderChartSvg(chart).includes('&lt;script&gt;'));
});
