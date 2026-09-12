export async function coinApi(database,login,request,response,route) { // Bearer-only external routes have explicit per-app CORS and never use browser session cookies.
  const send=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',Vary:'Origin, Authorization'});response.end(JSON.stringify(value));};
  try {
    const url=new URL(request.url,login.origin),clientId=url.searchParams.get('client_id');
    const call=(method,...args)=>database.economy.coins(method,...args),client=call('app',clientId);
    const origin=request.headers.origin;
    if(origin&&origin!==login.origin&&!client.origins.includes(origin))throw Object.assign(Error('Origin not allowed.'),{status:403});
    if(origin){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');response.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');}
    if(request.method==='OPTIONS')return send(204,undefined);
    let input;
    if(request.method==='POST') {
      const chunks=[];let size=0;
      for await(const chunk of request){size+=chunk.length;if(size>8192)throw Object.assign(Error('Request too large.'),{status:413});chunks.push(chunk);}
      const text=Buffer.concat(chunks).toString('utf8'),type=request.headers['content-type']??'';
      if(type.startsWith('application/json')){try{input=JSON.parse(text);}catch{throw Object.assign(Error('Invalid JSON.'),{status:400});}}
      else if(type.startsWith('application/x-www-form-urlencoded')&&['device','token'].includes(route))input=Object.fromEntries(new URLSearchParams(text));
      else throw Object.assign(Error('Send application/json.'),{status:415});
      if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(Error('Supply a JSON object.'),{status:400});
      if(input.client_id&&input.client_id!==clientId)throw Object.assign(Error('Client mismatch.'),{status:400});
    }
    if(request.method==='POST'&&route==='device')return send(200,{...call('begin',{...input,client_id:clientId},request.socket.remoteAddress??'unknown'),verification_uri:new URL(url.pathname.replace(/api\/lidollcoin\/v1\/.*$/,'coins/'),login.origin).href});
    if(request.method==='POST'&&route==='token')return send(200,call('token',{...input,client_id:clientId}));
    const secret=/^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization??'')?.[1];
    const identity=call('grant',secret);
    if(identity.client!==clientId)throw Object.assign(Error('Token belongs to another app.'),{status:403});
    if(request.method==='GET'&&route==='wallet')return send(200,call('balance',secret));
    if(request.method==='POST'&&route==='operations')return send(200,call('operation',secret,input));
    if(request.method==='POST'&&route==='revoke')return send(200,call('revoke',identity.owner,identity.id));
    return send(404,{error:'not_found',error_description:'Endpoint not found.'});
  }catch(error){send(error.status??500,{error:error.code??'request_failed',error_description:error.status?error.message:'Wallet request failed. Retry with the same request ID.'});}
}
