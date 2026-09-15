const galleryObservers=new WeakMap();
export function clearPostGalleries(container){for(const gallery of container.querySelectorAll('.post-gallery')){galleryObservers.get(gallery)?.disconnect();galleryObservers.delete(gallery);}container.replaceChildren();} // Release resize observers whenever private feed content is cleared or replaced.
export function createPostGallery(post) {
 const node=(tag,className)=>{const element=document.createElement(tag);element.className=className;return element;};
 const multiple=post.pictures.length>1,gallery=node('div',multiple?'post-gallery':'status-gallery post-single-picture');
 const track=multiple?node('div','post-gallery-track'):gallery;
 if(multiple){gallery.setAttribute('role','group');gallery.setAttribute('aria-roledescription','carousel');gallery.setAttribute('aria-label','Photos shared by '+post.author.label);track.id='post-gallery-'+post.id;track.tabIndex=0;track.setAttribute('role','group');track.setAttribute('aria-label','Photos. Swipe or use the left and right arrow keys.');gallery.append(track);}
 const slides=post.pictures.map((picture,index)=>{
  const image=node('img','post-photo');image.src='./api/social/picture?id='+encodeURIComponent(picture.id);image.alt=picture.alt||'Picture shared by '+post.author.label;image.loading='lazy';image.width=picture.width;image.height=picture.height;image.draggable=false;
  if(!multiple){track.append(image);return image;}
  const slide=node('div','post-gallery-slide');slide.setAttribute('role','group');slide.setAttribute('aria-roledescription','slide');slide.setAttribute('aria-label','Photo '+(index+1)+' of '+post.pictures.length);slide.append(image);track.append(slide);return slide;
 });
 if(!multiple)return gallery;
 let current=0,width=track.clientWidth;
 const controls=node('div','post-gallery-controls'),counter=node('span','post-gallery-counter');counter.setAttribute('role','status');counter.setAttribute('aria-live','polite');counter.setAttribute('aria-atomic','true');
 function go(index){const target=Math.max(0,Math.min(slides.length-1,index));track.scrollTo({left:target*track.clientWidth,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});} // Native scrolling keeps touch swipes, trackpads and zoom available.
 function button(label,step){const element=node('button','button small secondary');element.type='button';element.textContent=label;element.setAttribute('aria-controls',track.id);element.addEventListener('click',()=>go(current+step));return element;}
 const previous=button('Previous photo',-1),next=button('Next photo',1);controls.append(previous,counter,next);gallery.append(controls);
 function update(){if(width!==track.clientWidth)return;const index=Math.max(0,Math.min(slides.length-1,Math.round(track.scrollLeft/(width||1))));if(counter.textContent&&index===current)return;current=index;counter.textContent=(index+1)+' / '+slides.length;previous.disabled=index===0;next.disabled=index===slides.length-1;slides.forEach((slide,i)=>slide.setAttribute('aria-hidden',String(i!==index)));} // Announce only photo changes, not every scroll event.
 const observer=new ResizeObserver(()=>{if(width===track.clientWidth)return;width=track.clientWidth;track.scrollTo({left:current*width,behavior:'instant'});update();});observer.observe(track);galleryObservers.set(gallery,observer); // Keep the selected photo aligned after rotation, theme changes or desktop resizing.
 track.addEventListener('scroll',update,{passive:true});track.addEventListener('keydown',event=>{if(event.target!==track||event.altKey||event.ctrlKey||event.metaKey)return;const target={ArrowLeft:current-1,ArrowRight:current+1,Home:0,End:slides.length-1}[event.key];if(target===undefined)return;event.preventDefault();go(target);});update();
 return gallery;
} // Each post owns its controls; picture URLs keep the existing authenticated access checks.
