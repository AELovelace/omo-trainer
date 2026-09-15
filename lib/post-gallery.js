const galleryObservers=new WeakMap();
const galleryPositions=new WeakMap();
let viewer=null;
function closePhotoViewer(){
 if(!viewer)return;const {dialog,opener,owner,index,scrolls}=viewer;viewer=null;dialog.close();clearPostGalleries(dialog);dialog.remove();document.documentElement.classList.remove('photo-viewing');if(opener.isConnected){galleryPositions.get(owner)?.(index);opener.focus({preventScroll:true});for(const [element,top] of scrolls)if(element.isConnected)element.scrollTop=top;}
} // Remove private images and observers on close, including when the underlying feed is cleared.
function openPhotoViewer(post,index,owner,opener){
 closePhotoViewer();const dialog=document.createElement('dialog');dialog.id='photo-viewer';dialog.className='photo-viewer';dialog.setAttribute('aria-label','Photos shared by '+post.author.label);
 const header=document.createElement('header'),title=document.createElement('strong'),close=document.createElement('button');header.className='photo-viewer-heading';title.textContent='Photos';close.type='button';close.className='button secondary';close.textContent='Close';close.setAttribute('aria-label','Close fullscreen photos');close.autofocus=true;close.addEventListener('click',closePhotoViewer);header.append(title,close);
 dialog.append(header,createPostGallery(post,{expanded:true,start:index}));dialog.addEventListener('cancel',event=>{event.preventDefault();closePhotoViewer();});dialog.addEventListener('close',()=>{if(viewer?.dialog===dialog)closePhotoViewer();});
 const scrolls=[];for(let element=opener.parentElement;element;element=element.parentElement)scrolls.push([element,element.scrollTop]);
 document.body.append(dialog);viewer={dialog,owner,opener,index,scrolls};document.documentElement.classList.add('photo-viewing');dialog.showModal();
} // A native modal keeps focus inside the viewer and covers fixed navigation without changing the feed position.
export function clearPostGalleries(container){if(viewer&&container.contains(viewer.owner))closePhotoViewer();for(const gallery of container.querySelectorAll('.post-gallery')){galleryObservers.get(gallery)?.disconnect();galleryObservers.delete(gallery);}container.replaceChildren();} // Release resize observers whenever private feed content is cleared or replaced.
export function createPostGallery(post,{expanded=false,start=0}={}) {
 const node=(tag,className)=>{const element=document.createElement(tag);element.className=className;return element;};
 const multiple=expanded||post.pictures.length>1,gallery=node('div',multiple?'post-gallery':'status-gallery post-single-picture');
 const track=multiple?node('div','post-gallery-track'):gallery;
 if(multiple){gallery.setAttribute('role','group');gallery.setAttribute('aria-roledescription','carousel');gallery.setAttribute('aria-label','Photos shared by '+post.author.label);track.id=(expanded?'fullscreen-gallery-':'post-gallery-')+post.id;track.tabIndex=0;track.setAttribute('role','group');track.setAttribute('aria-label','Photos. Swipe or use the left and right arrow keys.');gallery.append(track);}
 const slides=post.pictures.map((picture,index)=>{
  const image=node('img','post-photo');image.src='./api/social/picture?id='+encodeURIComponent(picture.id);image.alt=picture.alt||'Picture shared by '+post.author.label;image.loading='lazy';image.width=picture.width;image.height=picture.height;image.draggable=false;
  let content=image;if(!expanded){const opener=node('button','post-photo-open');opener.type='button';opener.setAttribute('aria-haspopup','dialog');opener.setAttribute('aria-label','Open photo '+(index+1)+' of '+post.pictures.length+' fullscreen');opener.append(image);opener.addEventListener('click',()=>openPhotoViewer(post,index,gallery,opener));content=opener;}else image.loading='eager';
  if(!multiple){track.append(content);return content;}
  const slide=node('div','post-gallery-slide');slide.setAttribute('role','group');slide.setAttribute('aria-roledescription','slide');slide.setAttribute('aria-label','Photo '+(index+1)+' of '+post.pictures.length);slide.append(content);track.append(slide);return slide;
 });
 if(!multiple)return gallery;
 let current=start,width=track.clientWidth;
 const controls=node('div','post-gallery-controls'),counter=node('span','post-gallery-counter');counter.setAttribute('role','status');counter.setAttribute('aria-live','polite');counter.setAttribute('aria-atomic','true');
 function go(index){const target=Math.max(0,Math.min(slides.length-1,index));track.scrollTo({left:target*track.clientWidth,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});} // Native scrolling keeps touch swipes, trackpads and zoom available.
 function button(label,step){const element=node('button','button small secondary');element.type='button';element.textContent=label;element.setAttribute('aria-controls',track.id);element.addEventListener('click',()=>go(current+step));return element;}
 const previous=button('Previous photo',-1),next=button('Next photo',1);controls.append(previous,counter,next);gallery.append(controls);const caption=expanded?node('p','photo-viewer-caption'):null;if(caption)gallery.append(caption);
 function update(){if(!width||width!==track.clientWidth)return;const index=Math.max(0,Math.min(slides.length-1,Math.round(track.scrollLeft/width)));if(counter.textContent&&index===current)return;current=index;counter.textContent=(index+1)+' / '+slides.length;previous.disabled=index===0;next.disabled=index===slides.length-1;if(caption)caption.textContent=post.pictures[index].alt||'';slides.forEach((slide,i)=>{slide.setAttribute('aria-hidden',String(i!==index));const opener=slide.querySelector('.post-photo-open');if(opener)opener.tabIndex=i===index?0:-1;});} // Announce only photo changes, not every scroll event.
 const observer=new ResizeObserver(()=>{if(width===track.clientWidth)return;width=track.clientWidth;track.scrollTo({left:current*width,behavior:'instant'});update();});observer.observe(track);galleryObservers.set(gallery,observer); // Keep the selected photo aligned after rotation, theme changes or desktop resizing.
 galleryPositions.set(gallery,index=>{current=index;width=track.clientWidth;track.scrollTo({left:index*width,behavior:'instant'});counter.textContent='';update();}); // Restore the tapped thumbnail even if rotation re-snapped the inert feed behind the modal.
 track.addEventListener('scroll',update,{passive:true});gallery.addEventListener('keydown',event=>{if((!expanded&&event.target!==track&&!event.target.closest('.post-photo-open'))||event.altKey||event.ctrlKey||event.metaKey)return;const target={ArrowLeft:current-1,ArrowRight:current+1,Home:0,End:slides.length-1}[event.key];if(target===undefined)return;event.preventDefault();go(target);});update();
 return gallery;
} // Each post owns its controls; picture URLs keep the existing authenticated access checks.
