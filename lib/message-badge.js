let busy=false,again=false,epoch=0;
function show(unread){
 for(const badge of document.querySelectorAll('[data-message-badge]')){badge.hidden=unread===0;badge.textContent=unread>99?'99+':String(unread);badge.setAttribute('aria-hidden','true');}
 for(const link of document.querySelectorAll('[data-message-shortcut]'))link.setAttribute('aria-label',unread?'Messaging, '+unread+' unread message'+(unread===1?'':'s'):'Messaging');
} // The visible number stays compact while the accessible label retains the exact unread count.
function clear(){epoch++;show(0);} // Never retain private unread state while signed out, hidden or offline.
async function refresh(){
 if(document.hidden||!navigator.onLine)return;if(busy){again=true;return;}busy=true;const ticket=epoch;
 try{const response=await fetch('./api/social/messages/unread',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});if(ticket!==epoch){await response.body?.cancel();return;}if(!response.ok){await response.body?.cancel();if(ticket!==epoch)return;show(0);if(response.status===401)window.dispatchEvent(new Event('little-log-social-denied'));return;}const value=await response.json();if(ticket===epoch)show(Number.isSafeInteger(value.unread)&&value.unread>=0?value.unread:0);}
 catch{if(ticket===epoch)show(0);}finally{busy=false;if(again){again=false;void refresh();}}
} // Poll a count-only endpoint across app pages; opening the badge never marks a conversation read.
window.addEventListener('little-log-messages-updated',()=>void refresh());window.addEventListener('hashchange',()=>void refresh());window.addEventListener('online',()=>void refresh());
window.addEventListener('little-log-social-locked',clear);window.addEventListener('little-log-signout',clear);window.addEventListener('offline',clear);window.addEventListener('storage',event=>{if((event.key==='lidoll.little-log.v1'||event.key===null)&&!event.newValue)clear();});
document.addEventListener('visibilitychange',()=>{clear();if(!document.hidden)void refresh();});
setInterval(()=>void refresh(),15000);show(0);void refresh();
