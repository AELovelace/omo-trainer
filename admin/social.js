export function createSocialModeration({request,authorized}) {
 const $=id=>document.getElementById('moderation-'+id),node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 let busy=false,epoch=0,before=null,next=null,postId=null;
 function button(text,fn){const n=node('button',text);n.className='button secondary small';n.type='button';n.addEventListener('click',fn);return n;}
 function controls(){for(const n of document.querySelectorAll('[data-panel="moderation"] button,[data-panel="moderation"] select'))n.disabled=busy||!authorized();$('older').hidden=next===null;$('newest').hidden=before===null&&!postId;}
 async function act(input){if(busy||!authorized())return;const reason=$('reason').value.trim();if(!reason){$('status').textContent='Enter a moderation reason first.';$('reason').focus();return;}
  if(!confirm(input.action==='remove'?'Remove this content permanently?':input.action==='restrict'?'Pause this member’s social posting and messaging?':'Save this moderation decision?'))return;
  busy=true;controls();const ticket=epoch;
  try{await request('social',{...input,reason});if(ticket!==epoch)return;$('status').textContent='Moderation decision saved and added to the activity log.';if(input.action==='remove'&&input.kind==='post')postId=null;}
  catch(error){$('status').textContent=error.message;return;}finally{busy=false;controls();}await load();
 } // Every action includes a human-entered reason and is reauthorized and audited by the server.
 function contentCard(kind,item,id) {
  const card=node('article');card.className='moderation-card';card.append(node('h3',item.authorLabel??item.author?.label??'Member'),node('p',item.body));card.lastChild.className='social-body';
  if(item.pictures?.length){const gallery=node('div');gallery.className='status-gallery';for(const picture of item.pictures){const img=node('img');img.src='../api/admin/social/picture?id='+encodeURIComponent(picture.id);img.alt=picture.alt||'Posted picture';img.loading='lazy';gallery.append(img);}card.append(gallery);}
  const actions=node('div');actions.className='admin-buttons';actions.append(button('Remove '+kind,()=>void act({action:'remove',kind,id})));
  const author=typeof item.author==='string'?item.author:item.author?.id;if(author)actions.append(button('Pause social access',()=>void act({action:'restrict',participantId:author})));
  if(kind==='post')actions.append(button('Review comments',()=>{postId=id;before=null;void load();}));card.append(actions);return card;
 }
 async function load(){if(busy||!authorized())return;busy=true;controls();const ticket=epoch;
  try{const query=new URLSearchParams({view:$('view').value});if(before)query.set('before',before);if(postId)query.set('postId',postId);const value=await request('social?'+query);if(ticket!==epoch||!authorized())return;next=value.nextBefore;$('list').replaceChildren();
   if(value.post)$('list').append(contentCard('post',value.post,value.post.id));
   for(const item of value.items){let card;
    if(postId)card=contentCard('comment',item,item.id);
    else if($('view').value==='posts'){card=contentCard('post',item,item.id);card.prepend(node('p',item.audience==='public'?'Public post':'Friends post'));}
    else if($('view').value==='restrictions'){card=node('article');card.className='moderation-card';card.append(node('h3',item.label),node('p',item.reason),button('Restore social access',()=>void act({action:'restore',participantId:item.owner})));}
    else {card=node('article');card.className='moderation-card';card.append(node('h3','Reported '+item.kind),node('p','Reported by '+item.reporterLabel+' on '+new Date(item.created).toLocaleString()),node('p',item.reason));
     if(item.content){card.append(contentCard(item.kind,item.content,item.target));if(item.content.postId)card.append(button('Review post and pictures',()=>{postId=item.content.postId;before=null;void load();}));}
     else card.append(node('p','The reported content has been removed.'));
     card.append(button('Dismiss report',()=>void act({action:'dismiss',reportId:item.id})));
    }$('list').append(card);
   }
   if(!value.items.length&&!value.post)$('list').append(node('p','Nothing to review in this view.'));
  }catch(error){$('list').replaceChildren();$('status').textContent=error.message;}finally{busy=false;controls();}
 }
 function clear(){epoch++;$('list').replaceChildren();$('reason').value='';$('status').textContent='';postId=null;before=null;next=null;controls();}
 $('view').addEventListener('change',()=>{before=null;postId=null;void load();});$('refresh').addEventListener('click',()=>void load());$('older').addEventListener('click',()=>{before=next;void load();});$('newest').addEventListener('click',()=>{before=null;postId=null;void load();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();else if(location.hash==='#moderation')void load();});
 window.addEventListener('hashchange',()=>{if(location.hash!=='#moderation')clear();});return {load,clear};
} // Moderation views remain in memory; only explicitly reported private messages are returned by the API.
