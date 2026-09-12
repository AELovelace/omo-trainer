import {cookie} from './login.mjs';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};

export async function coinBrowserApi(database,login,request,response,route) { // Wallet-only browser sessions never authenticate scientific API requests.
  const base=new URL(request.url,login.origin).pathname.split('api/lidollcoin/browser/')[0];
  const path=base+'api/lidollcoin/browser/',secure=login.origin.startsWith('https:');
  const name=secure?'__Secure-lidollquest_wallet':'lidollquest_wallet';
  const sessionCookie=(value,age)=>`${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
  const call=(method,...args)=>database.economy.coins(method,...args);
  const send=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',Vary:'Cookie'});response.end(JSON.stringify(body));};
  const redirect=(location,cookies=[])=>{response.writeHead(303,{Location:location,'Set-Cookie':cookies,'Cache-Control':'no-store'});response.end();};
  try {
    const origin=request.headers.origin;
    if((request.headers['sec-fetch-site']==='cross-site'&&!(route==='connect'&&request.method==='GET'))||(origin&&origin!==login.origin))fail(403,'Open this page from LiDollQuest.');
    if(!['GET','POST'].includes(request.method))fail(405,'Method not allowed.');
    if(route==='connect'&&request.method==='GET') {
      const embedded=new URL(request.url,login.origin).searchParams.get('view')==='embedded';
      const loginReturn=embedded?'game-wallet-embedded':'game-wallet'; // Two fixed destinations preserve the game's view through OIDC without accepting arbitrary URLs.
      const session=login.session(request);
      if(!session)return redirect(base+'auth/login?returnTo='+loginReturn);
      call('app','lidollquest');
      const approved=call('browserApproved',session.participant.id);
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',Vary:'Cookie','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Referrer-Policy':'same-origin'});
      return response.end(`<!doctype html><html lang="en" data-theme="little-tracker"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#fff5fa"><title>Link LiDollQuest</title><link rel="stylesheet" href="${base}styles.css"><link rel="stylesheet" href="${base}themes.css"><link rel="stylesheet" href="${base}coins/style.css"><script defer src="${base}coins/browser.js"></script></head><body class="coins-connect"><main class="card"><h1>${approved?'Returning to LiDollQuest...':'Link LiDollQuest'}</h1><p>Signed in as <strong>${escape(session.participant.label)}</strong></p><p>${approved?'Your wallet access is already approved.':'Allow LiDollQuest to read, earn and spend your LiDollCoins.'}</p><form id="game-consent" method="post" action="${path}connect" data-approved="${approved}"><input type="hidden" name="view" value="${embedded?'embedded':'standalone'}"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button name="decision" value="allow" id="allow">${approved?'Continue to game':'Allow and return to game'}</button><button name="decision" value="deny">Cancel</button></form><p><a href="${base}auth/login?returnTo=${loginReturn}&amp;reauth=1">Use another account</a></p></main></body></html>`);
    }
    let input;
    if(request.method==='POST') {
      if(origin!==login.origin)fail(403,'This request must come from the game website.');
      let size=0;const chunks=[];
      for await(const chunk of request){size+=chunk.length;if(size>8192)fail(413,'Request too large.');chunks.push(chunk);}
      const text=Buffer.concat(chunks).toString('utf8'),type=request.headers['content-type']??'';
      if(route==='connect'&&type.startsWith('application/x-www-form-urlencoded'))input=Object.fromEntries(new URLSearchParams(text));
      else if(type.startsWith('application/json')){try{input=JSON.parse(text);}catch{fail(400,'Invalid JSON.');}}
      else fail(415,'Unsupported request format.');
      if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Supply a request object.');
    }
    if(route==='connect'&&request.method==='POST') {
      const session=login.session(request);
      if(!session)return redirect(base+'auth/login?returnTo='+(input.view==='embedded'?'game-wallet-embedded':'game-wallet'));
      if(input.csrf!==session.csrf)fail(403,'Refresh the sign-in page and try again.');
      const gameReturn=input.view==='embedded'?'/':'/game/'; // Return embedded players to the website that hosts their game frame.
      if(input.decision==='deny')return redirect(gameReturn+'?wallet=cancelled');
      if(input.decision!=='allow')fail(400,'Choose Allow or Cancel.');
      return redirect(gameReturn,[sessionCookie(call('browserIssue',session.participant.id,cookie(request,name)),2592000)]); // Fixed return URL and HttpOnly cookie keep credentials out of game code and redirects.
    }
    const secret=cookie(request,name);
    let session;
    try {session=call('browserSession',secret);}catch(error){
      if(error.status!==401)throw error;
      if(route==='session'&&request.method==='GET'){response.setHeader('Set-Cookie',sessionCookie('',0));return send(200,{linked:false});}
      throw error;
    }
    if(route==='session'&&request.method==='GET')return send(200,session);
    if(request.method==='POST'&&request.headers['x-csrf-token']!==session.csrf)fail(403,'Refresh your game connection before saving wallet changes.');
    if(route==='operations'&&request.method==='POST')return send(200,call('operation',secret,input));
    if(route==='revoke'&&request.method==='POST') {
      const identity=call('grant',secret);call('revoke',identity.owner,identity.id);
      response.setHeader('Set-Cookie',sessionCookie('',0));return send(200,{ok:true});
    }
    fail(404,'Endpoint not found.');
  }catch(error){send(error.status??500,{error:'wallet_request_failed',error_description:error.status?error.message:'Wallet temporarily unavailable. Your game will reconnect.'});}
}
