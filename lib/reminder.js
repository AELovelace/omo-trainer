const banner=document.querySelector('#admin-reminder');
const message=document.querySelector('#reminder-text'),repeat=document.querySelector('#reminder-repeat');
const track=banner.querySelector('.reminder-track'),viewport=banner.querySelector('.reminder-viewport');
const pause=document.querySelector('#reminder-pause');
let controller,paused=false;
function measure() { // Move each complete copy at a readable speed, including on resized mobile screens.
  if(banner.hidden)return;
  track.style.setProperty('--reminder-width',viewport.clientWidth+'px');
  track.style.setProperty('--reminder-duration',Math.max(12,message.getBoundingClientRect().width/40)+'s');
}
function hide() { // Do not keep showing a potentially withdrawn reminder when its current state cannot be checked.
  banner.hidden=true;message.textContent='';repeat.textContent='';
}
async function refresh() { // Public notices use the live API; they never enter the account data or offline cache.
  if(document.hidden)return;
  controller?.abort();const active=new AbortController();controller=active;
  const timeout=setTimeout(()=>active.abort(),8000);
  try {
    if(!navigator.onLine){hide();return;}
    const response=await fetch(new URL('api/reminder',document.baseURI),{cache:'no-store',credentials:'same-origin',signal:active.signal});
    if(!response.ok)throw new Error('Reminder unavailable');
    const value=await response.json();
    if(controller!==active)return;
    if(value.enabled!==true||typeof value.text!=='string'||!value.text.trim()){hide();return;}
    if(message.textContent!==value.text){message.textContent=value.text;repeat.textContent=value.text;}
    banner.hidden=false;measure();
  }catch {if(controller===active)hide();}
  finally {clearTimeout(timeout);}
}
pause.addEventListener('click',()=>{ // An explicit pause stays in effect across automatic reminder refreshes.
  paused=!paused;banner.classList.toggle('is-paused',paused);
  pause.textContent=paused?'Resume':'Pause';pause.setAttribute('aria-pressed',String(paused));
  pause.setAttribute('aria-label',paused?'Resume reminder scrolling':'Pause reminder scrolling');
});
new ResizeObserver(measure).observe(viewport);
window.addEventListener('focus',refresh);window.addEventListener('online',refresh);
window.addEventListener('offline',()=>{controller?.abort();hide();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
if(typeof BroadcastChannel==='function'){
  const channel=new BroadcastChannel('little-log-reminder');channel.addEventListener('message',refresh);
}
setInterval(refresh,30000);void refresh();
