const $=name=>document.getElementById('record-sharing-'+name);
let account=null,busy=false,epoch=0;
const visible=()=>location.hash.split('?')[0]==='#settings'&&!document.hidden&&navigator.onLine;
function controls(){const disabled=busy||!account||!visible();for(const name of ['enabled','audience','save'])$(name).disabled=disabled;$('refresh').disabled=busy||!visible();} // Sharing can only change after loading this account's saved choice.
function clear(){epoch++;account=null;$('enabled').checked=false;$('audience').value='friends';$('status').textContent='Sign in to manage timeline sharing.';controls();} // Sign-out and account changes never leave another member's opt-in selected.
async function request(input){
 const response=await fetch('./api/social/record-settings',{method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),headers:input?{'Content-Type':'application/json','X-CSRF-Token':account?.csrf??''}:{},...(input?{body:JSON.stringify(input)}:{})});
 const value=await response.json();if(!response.ok){if([401,403,409].includes(response.status))clear();throw Error(value.error||'Could not save timeline settings.');}return value;
} // Authenticated, versioned settings apply across devices and stay out of the offline cache.
function apply(value){account=value;$('enabled').checked=value.enabled;$('audience').value=value.audience;}
async function load(){if(busy||!visible())return;busy=true;controls();const ticket=epoch;
 try{const value=await request();if(ticket!==epoch)return;apply(value);$('status').textContent=value.enabled?'Sharing to '+(value.audience==='public'?'Public.':'Private (friends only).'):'Automatic posting is off.';}
 catch(error){if(visible())$('status').textContent=error.message;}finally{busy=false;controls();}
} // Refresh deliberately reloads the server choice after another device changes it.
$('form').addEventListener('submit',async event=>{
 event.preventDefault();if(busy||!account||!visible())return;busy=true;controls();const ticket=epoch;
 try{const value=await request({enabled:$('enabled').checked,audience:$('audience').value,version:account.version});if(ticket!==epoch)return;apply(value);$('status').textContent=value.enabled?'Saved. New records will post to '+(value.audience==='public'?'Public.':'Private (friends only).'):'Saved. Automatic posting is off.';}
 catch(error){if(visible())$('status').textContent=error.message;}finally{busy=false;controls();}
});
$('refresh').addEventListener('click',()=>void load());
window.addEventListener('hashchange',()=>{clear();void load();});window.addEventListener('little-log-signout',clear);window.addEventListener('offline',clear);window.addEventListener('online',()=>void load());
document.addEventListener('visibilitychange',()=>{clear();void load();});window.addEventListener('storage',event=>{if((event.key==='lidoll.little-log.v1'||event.key===null)&&!event.newValue)clear();});
if(visible())void load();else controls();
