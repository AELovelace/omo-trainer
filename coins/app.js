const $=s=>document.querySelector(s);let csrf='',code='',busy=false;
function clear() {csrf='';code='';$('#controls').hidden=true;$('#review').hidden=true;$('#connections').replaceChildren();$('#sign-in').hidden=false;$('#identity').textContent='';}
async function request(route,input) { // Only the signed-in account can review, approve or revoke its game connections.
  const response=await fetch('../api/'+route,{credentials:'same-origin',cache:'no-store',...(input?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)}:{})});
  const value=await response.json();if(!response.ok){if([401,403].includes(response.status))clear();throw Error(value.error||'Request failed.');}return value;
}
async function refresh() {
  try {const value=await request('coin-connections');csrf=value.csrf;$('#identity').textContent='Signed in as '+value.participant.label;$('#controls').hidden=false;$('#sign-in').hidden=true;$('#connections').replaceChildren();
    for(const app of value.connections){const row=document.createElement('p'),button=document.createElement('button');row.textContent=app.name+' ('+app.scope+') ';button.className='button secondary';button.textContent='Disconnect';button.onclick=()=>run(async()=>{await request('coin-revoke',{id:app.id});await refresh();$('#status').textContent='App disconnected.';});row.append(button);$('#connections').append(row);}
    if(!value.connections.length)$('#connections').textContent='No connected apps.';
  }catch(error){$('#status').textContent=error.message;}
}
async function run(fn) {if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(error){$('#status').textContent=error.message;}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
$('#code-form').onsubmit=event=>{event.preventDefault();void run(async()=>{code='';$('#review').hidden=true;const value=await request('coin-inspect',{user_code:$('#user-code').value.trim()});code=value.user_code;$('#app-name').textContent=value.name;$('#permissions').textContent=value.scope.includes('wallet:write')?'Allow this game to read, earn and spend your LiDollCoins. Game earnings are limited to '+value.daily_limit.toLocaleString()+' coins per UTC day.':'Allow this game to read your LiDollCoin balance.';$('#review').hidden=false;$('#status').textContent='Review the permissions before allowing this connection.';});};
for(const [id,approve] of [['approve',true],['deny',false]])$('#'+id).onclick=()=>run(async()=>{await request('coin-approve',{user_code:code,approve});code='';$('#review').hidden=true;$('#user-code').value='';$('#status').textContent=approve?'Approved. Return to your game to finish connecting.':'Connection denied.';await refresh();});
window.addEventListener('pagehide',clear);window.addEventListener('focus',()=>{if(!busy)void refresh();});void refresh();
