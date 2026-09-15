export function createAvatar(person={}) {
 const avatar=document.createElement('span');avatar.className='profile-avatar';
 const label=person.label||'Member',fallback=document.createElement('span');fallback.textContent=Array.from(label.trim())[0]?.toLocaleUpperCase()||'?';fallback.setAttribute('aria-hidden','true');avatar.append(fallback);
 if(person.avatarVersion){const image=document.createElement('img');image.src='./api/social/avatar?'+new URLSearchParams({owner:person.participantId??person.id,version:person.avatarVersion});image.alt=label+' profile picture';image.width=48;image.height=48;image.loading='lazy';image.addEventListener('error',()=>image.remove(),{once:true});avatar.append(image);}
 return avatar;
} // Load only the current picture version; removed or unavailable pictures fall back to an initial.
export function createIdentity(person,tag='strong',label=person.label) {
 const identity=document.createElement('a');identity.className='social-identity';identity.href='#profile?id='+encodeURIComponent(person.participantId??person.id);const name=document.createElement(tag);name.textContent=label;identity.append(createAvatar(person),name);return identity;
} // Names remain plain text inside a profile link, alongside the member's avatar.
