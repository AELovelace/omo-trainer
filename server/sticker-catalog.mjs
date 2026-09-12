import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {relative,join} from 'node:path';
import {createHash} from 'node:crypto';

export function stickerCatalog() { // Stable IDs follow relative filenames; restart the service after adding or renaming assets.
  const root=fileURLToPath(new URL('../sprites/',import.meta.url));
  const types={'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif'};
  let files;
  try {files=readdirSync(root,{recursive:true,withFileTypes:true});}
  catch(error) {if(['ENOENT','EACCES'].includes(error.code))return [];throw error;} // Missing assets leave rewards pending without preventing scientific recording.
  return files.filter(item=>item.isFile()).flatMap(item=>{
    const path=relative(root,join(item.parentPath,item.name)).replaceAll('\\','/');
    const extension=item.name.slice(item.name.lastIndexOf('.')).toLowerCase();
    if(!types[extension] || path.split('/').some(part=>part.startsWith('.') || part === '_originals')) return [];
    const label=item.name.slice(0,-extension.length).replace(/[_-]/g,' '); // Numbered assets get readable names without changing their stable IDs.
    return [{id:createHash('sha256').update(path).digest('hex').slice(0,24),name:/^\d+$/.test(label)?'Sticker '+label:label,path:'sprites/'+path,url:'sprites/'+path.split('/').map(encodeURIComponent).join('/'),mime:types[extension]}];
  }).sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true}));
}
