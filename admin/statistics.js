export function createStatisticsPanel({request,authorized}) { // Manage device credentials with the existing admin session and CSRF-protected request helper.
  const $=id=>document.getElementById('stats-'+id);let epoch=0,busy=false;
  function hide(){$('secret').value='';$('result').hidden=true;} // A token is shown once and never persisted in browser storage.
  async function refresh(){
    const version=epoch,value=await request('statistics/tokens');if(version!==epoch||!authorized())return;
    $('url').textContent=new URL('../api/statistics/v1/',location.href).href;
    const list=document.createElement('ul');
    for(const token of value.tokens){
      const item=document.createElement('li');item.textContent=token.name+' · '+(token.scope==='all'?'Everyone and individual views':'My statistics')+' · '+(token.revoked===null?'Active':'Revoked')+' ';
      if(token.revoked===null){const button=document.createElement('button');button.type='button';button.className='button secondary small';button.textContent='Revoke';button.addEventListener('click',()=>void perform(async()=>{await request('statistics/tokens/revoke',{id:token.id});hide();await refresh();$('status').textContent='Device token revoked.';}));item.append(button);}list.append(item);
    }
    $('list').replaceChildren(list);if(!value.tokens.length)$('list').textContent='No statistics devices connected.';
  }
  async function perform(action){if(busy||!authorized())return;const version=epoch;busy=true;$('create').disabled=true;try{await action();}catch(error){if(version===epoch)$('status').textContent=error.message;}finally{if(version===epoch){busy=false;$('create').disabled=!authorized();}}}
  $('form').addEventListener('submit',event=>{event.preventDefault();void perform(async()=>{
    const version=epoch;hide();const value=await request('statistics/tokens',{name:$('name').value,scope:$('scope').value});if(version!==epoch||!authorized())return;
    $('secret').value=value.token;$('result').hidden=false;$('status').textContent='Copy this token into the display configuration before leaving this page.';await refresh();
  });});
  $('hide').addEventListener('click',hide);
  return {load:()=>perform(refresh),clear(){epoch++;busy=false;hide();$('form').reset();for(const id of ['list','url','status'])$(id).textContent='';$('create').disabled=true;}};
}
