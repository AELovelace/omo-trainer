const $=id=>document.getElementById(id),pages=new Set(['social','post','feed','friends','messages','activity','profile']);
let generation=0,allowed=false;
const destination=()=>location.hash.slice(1).split('?')[0];
const visible=()=>pages.has(destination())&&!document.hidden;
function gate(message,checking=false,clear=false){
 allowed=false;$('social-content').hidden=true;$('social-navigation').hidden=true;$('social-access-gate').hidden=false;$('social-access-status').textContent=message;$('social-access-actions').hidden=checking;$('social-access-retry').disabled=checking||!navigator.onLine;
 if(clear)window.dispatchEvent(new Event('little-log-social-locked'));
} // Gate the entire Social shell, including direct profile, photo-post and Messaging links.
export function lockSocialAccess(){generation++;gate('Sign in or create an account to use Social.',false,true);} // A saved local participant is never proof of an authenticated session.
async function check(){
 if(!visible())return;const ticket=++generation,returnTo=destination();
 for(const action of ['login','register'])$('social-access-'+action).href='./auth/'+action+'?returnTo='+encodeURIComponent(returnTo);
 if(!navigator.onLine){gate('Reconnect to use Social.',false,true);return;}
 if(!allowed)gate('Checking your sign-in…',true);
 try{const response=await fetch('./api/social/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});if(ticket!==generation||!visible()){await response.body?.cancel();return;}
  if(!response.ok){await response.body?.cancel();if(ticket!==generation||!visible())return;gate(response.status===401||response.status===403?'Sign in or create an account to use Social.':'Could not check your sign-in. Try again.',false,true);return;}
  const value=await response.json();if(ticket!==generation||!visible())return;if(!value.participant?.id)throw Error('Missing account');
  const opening=!allowed;allowed=true;$('social-access-gate').hidden=true;$('social-content').hidden=false;$('social-navigation').hidden=false;if(opening)window.dispatchEvent(new Event('little-log-social-ready'));
 }catch{if(ticket===generation&&visible())gate('Could not check your sign-in. Reconnect and try again.',false,true);}
} // Only a live server session opens Social; failed checks keep cached/private content behind the gate.
$('social-access-retry').addEventListener('click',()=>void check());
for(const action of ['login','register'])$('social-access-'+action).addEventListener('click',()=>{try{sessionStorage.removeItem('little-log.connect');}catch{}}); // Social sign-in does not consent to uploading local tracker records.
window.addEventListener('hashchange',()=>{generation++;allowed=false;if(visible()){gate('Checking your sign-in…',true);void check();}});
window.addEventListener('little-log-social-denied',lockSocialAccess);window.addEventListener('little-log-signout',lockSocialAccess);
window.addEventListener('offline',()=>{generation++;gate('Reconnect to use Social.',false,true);});window.addEventListener('online',()=>void check());
document.addEventListener('visibilitychange',()=>{generation++;allowed=false;gate('Checking your sign-in…',true);if(visible())void check();});
window.addEventListener('storage',event=>{if((event.key==='lidoll.little-log.v1'||event.key===null)&&!event.newValue)lockSocialAccess();});
setInterval(()=>{if(visible())void check();},30000);void check();
