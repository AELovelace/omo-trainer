import {isIP} from 'node:net';
const fail=(status,message,code='invalid_grant')=>{throw Object.assign(new Error(message),{status,code});};
export async function verifyWalletIdentity(secret,clientId,{env=process.env,fetcher=fetch,now=Date.now}={}) { // Only configured identity infrastructure may vouch for account ownership and consent.
  if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{20,4096}$/.test(secret))fail(400,'Supply an OIDC access token.');
  const issuer=new URL(env.OIDC_ISSUER??'http://127.0.0.1:4180').origin;
  const url=new URL(env.LIDOLLCOIN_IDENTITY_URL??new URL('/wallet/identity',issuer));
  const [a,b]=url.hostname.split('.').map(Number),privateIp=isIP(url.hostname)===4&&(a===127||a===10||a===172&&b>=16&&b<=31||a===192&&b===168);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/wallet/identity'||!(url.protocol==='https:'||url.protocol==='http:'&&(privateIp||['localhost','[::1]'].includes(url.hostname))))fail(503,'The wallet identity endpoint is not configured.','server_error');
  let response;try{response=await fetcher(url,{headers:{Authorization:'Bearer '+secret,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{fail(503,'Identity verification is temporarily unavailable.','server_error');}
  if(!response.ok)fail(response.status>=500?503:401,'Sign in again and approve wallet permissions.');
  let value;try{value=await response.json();}catch{fail(503,'Identity verification returned an invalid response.','server_error');}
  const allowed=['wallet:read','wallet:write','stars:read','stars:write'],scopes=String(value?.scope??'').split(' ').filter(Boolean);
  if(value?.issuer!==issuer||value.client_id!==clientId||typeof value.subject!=='string'||!value.subject||value.subject.length>200||typeof value.username!=='string'||!scopes.length||scopes.some(s=>!allowed.includes(s))||!Number.isSafeInteger(value.expires_at)||value.expires_at<=Math.floor(now()/1000))fail(401,'This login does not authorize this app wallet.');
  return {...value,scope:[...new Set(scopes)].join(' ')};
}
