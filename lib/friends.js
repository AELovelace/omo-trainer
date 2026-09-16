import {createIdentity} from './avatar.js';
const $=selector=>document.querySelector(selector);
let account=null,busy=false,generation=0,sharePreview=null,offset=0,nextOffset=null;
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
const status=text=>$('#friends-status').textContent=text;
function controls(){$('#friend-shared-direction').disabled=busy;$('#friend-share-recipient').disabled=busy;for(const el of document.querySelectorAll('#page-friends button,#friend-share-dialog button:not([data-close-share])'))el.disabled=busy||!navigator.onLine;$('#friend-share-send').disabled=busy||!sharePreview||!$('#friend-share-recipient').value;}
function clear(keepDialog=false){generation++;account=null;sharePreview=null;offset=0;nextOffset=null;$('#friend-search-query').value='';for(const id of ['friends-list','friend-search-results','friend-shared-list','friend-share-preview'])$('#'+id).replaceChildren();$('#friend-share-recipient').replaceChildren();if(!keepDialog)$('#friend-share-dialog').close();$('#friend-shared-next').hidden=true;$('#friend-shared-first').hidden=true;controls();} // Private friend data stays in memory and disappears on sign-out, offline use or a hidden tab.
async function request(path='',input) {
 const requestGeneration=generation;
 const response=await fetch('./api/friends'+path,{method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),headers:input?{'Content-Type':'application/json','X-CSRF-Token':account?.csrf??''}:{},...(input?{body:JSON.stringify(input)}:{})});
 const value=await response.json();if(!response.ok){if(requestGeneration===generation){if(response.status===401)window.dispatchEvent(new Event('little-log-social-denied'));else if(response.status===403)clear($('#friend-share-dialog').open);}throw Error(value.error||'Friends could not be loaded.');}
 if(path&&value.participant&&account&&value.participant.id!==account.participant.id){clear($('#friend-share-dialog').open);throw Error('Your account changed. Refresh Friends.');}return value;
} // Cookies identify the member; only CSRF-protected requests can change a friendship or share.
function actionButton(text,action){const el=node('button',text,'button small secondary');el.type='button';el.addEventListener('click',action);return el;}
function details(record) {
 const labels={kind:'Record type',occurredAt:'Recorded at',liquidsMl:'Liquids (mL)',liquidsMode:'Intake period',position:'Position',diaperNumber:'Diaper number',wettingsCount:'Wettings',probability:'Pee chance (%)',result:'Result',source:'Source',edited:'Edited',category:'Category',rolledAt:'Rolled at',rolledResult:'Original result',desperation:'Desperation',baseProbability:'Base chance (%)',probabilityModifier:'Chance adjustment',desperationMode:'Desperation mode'};
 const list=node('dl',undefined,'friend-record-details');
 for(const [key,value] of Object.entries(record.entry??{}))if(key in labels){list.append(node('dt',labels[key]),node('dd',typeof value==='boolean'?(value?'Yes':'No'):String(value)));}
 return list;
} // Render the exact server preview as text, including all recorded fields that will be shared.
function renderFriends(items) {
 const list=$('#friends-list');list.replaceChildren();
 for(const friend of items){
  const item=node('article',undefined,'friend-row'),description=node('div');description.append(createIdentity(friend),node('p',friend.state==='accepted'?'Friends':friend.direction==='incoming'?'Wants to be your friend':'Request sent','field-help'));
  item.append(description);
  if(friend.state==='pending'&&friend.direction==='incoming')item.append(actionButton('Accept',()=>mutate('',{action:'accept',id:friend.id})));
  if(friend.state==='accepted')item.append(actionButton('Message',()=>document.dispatchEvent(new CustomEvent('little-log-message-friend',{detail:friend.participantId}))));
  const label=friend.state==='accepted'?'Remove friend':friend.direction==='incoming'?'Decline':'Cancel request';
  item.append(actionButton(label,()=>{if(friend.state!=='accepted'||confirm('Remove this friend? Shared-record access will end and your conversation will be deleted.'))void mutate('',{action:'remove',id:friend.id});}));list.append(item);
 }
 if(!items.length)list.append(node('p','No friends yet. Search by display name to send a request.','empty-state'));
}
async function loadShared(ticket=generation) {
 const data=await request('/shared?direction='+$('#friend-shared-direction').value+'&offset='+offset);if(ticket!==generation)return;
 const list=$('#friend-shared-list');list.replaceChildren();nextOffset=data.nextOffset;
 $('#friend-shared-next').hidden=nextOffset===null;$('#friend-shared-first').hidden=offset===0;
 for(const item of data.items){const card=node('article',undefined,'friend-shared-card'),outgoing=$('#friend-shared-direction').value==='outgoing';
  card.append(createIdentity(item.friend,'h3',(outgoing?'Shared with ':'From ')+item.friend.label),details(item.record));
  if(outgoing)card.append(actionButton('Stop sharing',()=>mutate('/unshare',{id:item.id})));list.append(card);
 }
 if(!data.items.length)list.append(node('p','No shared records here yet.','empty-state'));
} // Shared records are fetched live, so revoked access never becomes an offline copy in the app.
async function refresh() {
 if(busy)return;if(!navigator.onLine){clear();status('Reconnect to view friends and shared records.');return;}
 busy=true;const ticket=++generation;controls();status('Loading friends…');
 try {const data=await request();if(ticket!==generation)return;account=data;renderFriends(data.friends);await loadShared(ticket);if(ticket===generation)status('Share selected synced records using Share with friend in History.');}
 catch(error){if(ticket===generation){clear();status(error.message);}else if(!account)status(error.message);}finally{busy=false;controls();}
}
async function mutate(path,input) {
 if(busy||!account)return;busy=true;controls();const ticket=generation;
 try {await request(path,input);if(ticket!==generation)return;$('#friend-search-results').replaceChildren();status('Saved.');}
 catch(error){status(error.message);return;}finally{busy=false;controls();}
 await refresh();
}
export async function openFriendShare(recordId) {
 if(busy)return;
 $('#friend-share-status').textContent='Loading the saved record…';$('#friend-share-preview').replaceChildren();$('#friend-share-recipient').replaceChildren();sharePreview=null;
 $('#friend-share-dialog').showModal();busy=true;const ticket=++generation;controls();
 try {
  const data=await request();if(ticket!==generation)return;account=data;
  const value=await request('/record?id='+encodeURIComponent(recordId));if(ticket!==generation)return;
  sharePreview=value.record;$('#friend-share-preview').append(details(sharePreview));
  $('#friend-share-recipient').append(new Option('Choose a friend',''));
  for(const friend of data.friends.filter(f=>f.state==='accepted'))$('#friend-share-recipient').append(new Option(friend.label,friend.participantId));
  $('#friend-share-status').textContent=data.friends.some(f=>f.state==='accepted')?'Choose who can view this saved record.':'Accept a friend request on the Friends page before sharing.';
 }catch(error){$('#friend-share-status').textContent=error.message;}finally{busy=false;controls();}
} // Sharing starts from a read-only server preview; unsynced records cannot accidentally share different local data.
$('#friend-share-recipient').addEventListener('change',controls);
$('#friend-share-send').addEventListener('click',async()=>{
 if(busy||!sharePreview)return;busy=true;controls();const ticket=generation;
 try {await request('/share',{recordId:sharePreview.id,version:sharePreview.version,participantId:$('#friend-share-recipient').value});if(ticket!==generation)return;$('#friend-share-status').textContent='Record shared. Manage access on the Friends page.';sharePreview=null;}
 catch(error){$('#friend-share-status').textContent=error.message;}finally{busy=false;controls();}
});
$('#friend-share-dialog').addEventListener('close',()=>{generation++;sharePreview=null;$('#friend-share-preview').replaceChildren();controls();});
$('#friend-share-close').addEventListener('click',()=>$('#friend-share-dialog').close());
$('#friend-search-form').addEventListener('submit',async event=>{
 event.preventDefault();if(busy||!account)return;busy=true;controls();const ticket=generation;
 try {
  const data=await request('/search?q='+encodeURIComponent($('#friend-search-query').value));if(ticket!==generation)return;
  const list=$('#friend-search-results');list.replaceChildren();
  for(const member of data.members){const item=node('div',undefined,'friend-row');item.append(createIdentity(member));
   if(member.state==='none')item.append(actionButton('Add friend',()=>mutate('',{action:'request',participantId:member.participantId})));
   else item.append(node('span',member.state==='accepted'?'Already friends':member.direction==='incoming'?'Request received':'Request sent','field-help'));list.append(item);
  }
  if(!data.members.length)list.append(node('p','No matching members. Try another display name.','empty-state'));status('Up to 20 matching members shown.');
 }catch(error){status(error.message);}finally{busy=false;controls();}
});
$('#friends-refresh').addEventListener('click',()=>void refresh());
$('#friend-shared-direction').addEventListener('change',()=>{offset=0;void refresh();});
$('#friend-shared-next').addEventListener('click',()=>{if(nextOffset!==null){offset=nextOffset;void refresh();}});
$('#friend-shared-first').addEventListener('click',()=>{offset=0;void refresh();});
window.addEventListener('little-log-social-locked',()=>clear());window.addEventListener('little-log-social-ready',()=>{if(location.hash==='#friends')void refresh();});
window.addEventListener('little-log-signout',()=>{clear();status('Sign in to use Friends.');});
window.addEventListener('offline',()=>{clear();status('Reconnect to view friends and shared records.');});
window.addEventListener('online',()=>{if(location.hash==='#friends')void refresh();});
window.addEventListener('hashchange',()=>{if(location.hash==='#friends')void refresh();else clear();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();else if(location.hash==='#friends')void refresh();});
window.addEventListener('storage',event=>{if((event.key==='lidoll.little-log.v1'||event.key===null)&&!event.newValue){clear();status('Sign in to use Friends.');}});
if(location.hash==='#friends')void refresh();else controls();
