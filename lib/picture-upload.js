const sourceLimit=100*1024*1024;
async function decode(file){
 try{if(typeof createImageBitmap==='function')return await createImageBitmap(file);}catch{} // Some browsers can open camera formats through an image element instead.
 const image=new Image();
 try{image.src=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});await image.decode();return {image,width:image.naturalWidth,height:image.naturalHeight,close:()=>image.removeAttribute('src')};}
 catch{image.removeAttribute('src');throw Error('Your browser could not open this picture. Export it as JPEG or PNG and try again.');} // Use the app's permitted data URLs without widening the Content Security Policy.
}
export async function preparePicture(file,{square=false,maxBytes=square?128*1024:1400*1024,maxSide=square?512:1600}={}){
 if(file.size>sourceLimit)throw Error('Choose a picture up to 100 MB. Large photos are resized automatically.');
 if(file.type==='image/svg+xml'||(!/^image\/(jpeg|png|webp|gif|bmp|avif|heic|heif)$/.test(file.type)&&!(/^$|^application\/octet-stream$/.test(file.type)&&/\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name??''))))throw Error('Choose a photo such as JPEG, PNG or WebP.');
 const bitmap=await decode(file);
 try{
  const side=Math.min(bitmap.width,bitmap.height),scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
  let width=square?maxSide:Math.max(1,Math.round(bitmap.width*scale)),height=square?maxSide:Math.max(1,Math.round(bitmap.height*scale));
  const canvas=document.createElement('canvas');
  for(;;){
   canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');if(!context)throw Error('Could not prepare this picture. Please try again.');
   context.fillStyle='#fff';context.fillRect(0,0,width,height);
   if(square)context.drawImage(bitmap.image??bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,width,height);else context.drawImage(bitmap.image??bitmap,0,0,width,height);
   for(const quality of [0.86,0.76,0.64,0.5]){const data=canvas.toDataURL('image/jpeg',quality).split(',')[1];if(data&&data.length<=Math.floor(maxBytes/3)*4)return {data,alt:''};}
   if(width===1&&height===1)throw Error('Could not prepare this picture. Please try again.');
   width=Math.max(1,Math.floor(width*0.75));height=Math.max(1,Math.floor(height*0.75)); // Lower dimensions only when JPEG quality adjustments cannot meet the upload budget.
  }
 }finally{bitmap.close();}
} // Compress the actual JPEG bytes, including room for base64 and JSON, instead of rejecting ordinary camera originals.
export async function compactPictures(pictures){
 const maxBytes=Math.floor(168*1024/pictures.length),result=[];for(const picture of pictures){const bytes=Uint8Array.from(atob(picture.data),char=>char.charCodeAt(0)),ready=await preparePicture(new Blob([bytes],{type:'image/jpeg'}),{maxBytes});result.push({...picture,data:ready.data});}return result;
} // Share the proxy budget across the selected photos, leaving room for base64, descriptions and post text.
