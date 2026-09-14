import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
const {WalletClient}=await import(pathToFileURL(resolve(process.env.MOMMYBOT_ROOT??'../MommyBot','src/wallet/client.js')).href);
process.env.NODE_ENV='test';const db=openDatabase(':memory:',{stickerCatalog:[]}),user=db.ensureParticipant('test','bot-diamonds','Synthetic account');
const login={origin:'',session:()=>null},api=createApi(db,login);
const server=createServer((request,response)=>{const route=new URL(request.url,'http://local').pathname.split('/').at(-1);return api(request,response,route==='login-bonuses'?route:'lidollcoin/v1/'+route);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));login.origin='http://127.0.0.1:'+server.address().port;
try {
 const client=new WalletClient({baseUrl:login.origin+'/v1/',clientId:'lidollquest',verificationOrigin:login.origin});
 const device=await client.begin();db.economy.coins('approve',user.id,{user_code:device.user_code,approve:true});const grant=await client.poll(device.device_code);
 assert.ok(grant.scope.includes('diamonds:write'));assert.equal((await client.balance(grant.access_token)).diamonds,0);
 const credit={asset:'diamonds',kind:'credit',amount:4,request_id:'bot-credit'};const receipt=await client.operation(grant.access_token,credit);
 assert.equal(receipt.currency,'Diamonds');assert.deepEqual(await client.operation(grant.access_token,credit),receipt);
 await client.operation(grant.access_token,{asset:'diamonds',kind:'debit',amount:1,request_id:'bot-debit'});
 await client.operation(grant.access_token,{asset:'diamonds',kind:'refund',original_id:'bot-debit',request_id:'bot-refund'});
 const balance=await client.balance(grant.access_token);assert.equal(balance.diamonds,4);assert.equal(balance.coins,0);assert.equal(balance.stars,0);
 assert.equal((await fetch(login.origin+'/login-bonuses',{headers:{Authorization:'Bearer '+grant.access_token}})).status,401,'A wallet bearer token cannot access the session-only calendar');
 await client.revoke(grant.access_token);await assert.rejects(client.balance(grant.access_token),error=>error.status===401);
 console.log('PASS: real MommyBot WalletClient and tracker HTTP API agree on diamond consent, balance, credit/retry, debit/refund and revocation.');
}finally{await new Promise(resolve=>server.close(resolve));db.close();}
