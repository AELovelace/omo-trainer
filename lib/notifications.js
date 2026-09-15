const $=selector=>document.querySelector(selector);
const supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window&&window.isSecureContext;
let config=null,registration=null,busy=false;
const timezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const status=text=>$('#notification-status').textContent=text;
async function request(route,input) { // Session ownership and CSRF are checked on every subscription change.
 const response=await fetch('./api/'+route,{method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),headers:input?{'Content-Type':'application/json','X-CSRF-Token':config?.csrf??''}:{},...(input?{body:JSON.stringify(input)}:{})});
 const value=await response.json();if(!response.ok)throw Error(value.error||'Could not update notifications.');return value;
}
function controls() {
 for(const id of ['social-likes','social-comments','friend-posts'])$('#notification-'+id).disabled=busy||!config;
 $('#notification-admin-messages').disabled=busy||!config;
 $('#notification-community-support').disabled=busy||!config;
 $('#notification-community-friends-only').disabled=busy||!config;
 $('#notification-community-anonymous').disabled=busy||!config;
 $('#notification-enable').disabled=busy||!supported||!config?.configured||!registration;
 $('#notification-disable').disabled=busy||!config?.subscriptions;
 $('#notification-save').disabled=busy||!config?.subscriptions||!supported;
}
function payload(sub) {return {subscription:sub.toJSON(),timeZone:timezone(),quietStart:Number($('#notification-quiet-start').value),quietEnd:Number($('#notification-quiet-end').value),adminMessages:$('#notification-admin-messages').checked,communitySupport:$('#notification-community-support').checked,communityAnonymous:$('#notification-community-anonymous').checked,communityFriendsOnly:$('#notification-community-friends-only').checked,socialLikes:$('#notification-social-likes').checked,socialComments:$('#notification-social-comments').checked,friendPosts:$('#notification-friend-posts').checked};}
async function refresh() {
 if(busy)return;busy=true;controls();$('#notification-timezone').textContent=timezone();
 try {
  config=await request('notifications');
  for(const [id,field] of [['social-likes','socialLikes'],['social-comments','socialComments'],['friend-posts','friendPosts']])$('#notification-'+id).checked=config.preferences?.[field]===undefined?true:Boolean(config.preferences[field]);
  $('#notification-community-support').checked=config.preferences?Boolean(config.preferences.communitySupport):true; // New subscribers default on; saved opt-outs survive reloads and new devices.
  $('#notification-community-anonymous').checked=Boolean(config.preferences?.communityAnonymous); // Saved anonymity applies across devices; new members share their display name.
  $('#notification-community-friends-only').checked=Boolean(config.preferences?.communityFriendsOnly);
  if(config.preferences){$('#notification-admin-messages').checked=Boolean(config.preferences.adminMessages);$('#notification-quiet-start').value=config.preferences.quietStart;$('#notification-quiet-end').value=config.preferences.quietEnd;}
  if(!supported){status('Push notifications are unavailable in this browser. On iPhone or iPad, add Little Log to your Home Screen first.');return;}
  registration=await navigator.serviceWorker.ready;
  const sub=await registration.pushManager.getSubscription();
  if(sub&&config.subscriptions&&config.preferences?.timeZone!==timezone())await request('notifications',payload(sub)); // Travel updates use the actual browser IANA zone, not a guessed offset.
  status(!config.configured?'Notifications are waiting for server setup.':Notification.permission==='denied'?'Notifications are blocked. You can allow them in your browser settings.':sub&&config.subscriptions?'Notifications are enabled on this device.':'Notifications are off on this device.');
 }catch(error){config=null;status(error.message);}finally{busy=false;controls();}
}
for(const selector of ['#notification-quiet-start','#notification-quiet-end'])$(selector).replaceChildren(...Array.from({length:24},(_,hour)=>new Option(String(hour).padStart(2,'0')+':00',hour)));
$('#notification-quiet-start').value='22';$('#notification-quiet-end').value='8';
$('#notification-enable').addEventListener('click',async()=>{
 if(busy||!config?.configured||!supported||!registration)return;
 const permission=Notification.requestPermission(); // Called directly from the click to satisfy browser/iOS user-gesture requirements.
 busy=true;controls();let created=null;
 try {
  if(await permission!=='granted'){status('Notifications were not enabled.');return;}
  let sub=await registration.pushManager.getSubscription();
  if(!sub){const key=config.publicKey.replaceAll('-','+').replaceAll('_','/');const bytes=Uint8Array.from(atob(key+'='.repeat((4-key.length%4)%4)),c=>c.charCodeAt(0));sub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});created=sub;}
  const value=await request('notifications',payload(sub));config={...config,...value};status('Notifications enabled. Your notification preferences apply to all your devices.');
 }catch(error){if(created)await created.unsubscribe().catch(()=>{});status(error.message);}finally{busy=false;controls();}
});
$('#notification-save').addEventListener('click',async()=>{
 if(busy)return;busy=true;controls();
 try{const sub=await registration.pushManager.getSubscription();if(!sub)throw Error('Enable notifications on this device first.');config={...config,...await request('notifications',payload(sub))};status('Notification preferences and quiet hours saved.');}
 catch(error){status(error.message);}finally{busy=false;controls();}
});
$('#notification-disable').addEventListener('click',async()=>{
 if(busy)return;busy=true;controls();
 try{config={...config,...await request('notifications/disable',{all:true})};const sub=await registration?.pushManager.getSubscription();await sub?.unsubscribe();status('Notifications turned off on all your devices.');}
 catch(error){status(error.message);}finally{busy=false;controls();}
});
window.addEventListener('hashchange',()=>{if(location.hash==='#settings')void refresh();});
window.addEventListener('online',()=>{if(location.hash==='#settings')void refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&location.hash==='#settings')void refresh();});
if(location.hash==='#settings')void refresh();else controls();
