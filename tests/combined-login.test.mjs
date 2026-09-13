import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {walletIdentity} from '../auth/wallet-identity.mjs';import {verifyWalletIdentity} from '../server/coin-identity.mjs';import {createCoinApiStore,coinApps} from '../server/coin-api-store.mjs';import {authPage} from '../auth/views.mjs';
const scope='wallet:read wallet:write stars:read stars:write',secret='s'.repeat(43),identity={issuer:'https://auth.example',subject:'alice',username:'Alice',client_id:'lidollbot',scope,expires_at:Math.floor(Date.now()/1000)+600};
test('identity proof requires a live access token, explicit wallet consent, grant and enabled account',async()=>{
 let token={accountId:'alice',grantId:'grant',clientId:'lidollbot',scope,exp:identity.expires_at},account={id:'alice',username:'Alice'},grant={};
 const provider={AccessToken:{find:async()=>token},Grant:{find:async()=>grant}},store={account:()=>account};
 assert.deepEqual(await walletIdentity(provider,store,identity.issuer,secret),identity);
 token.scope='openid profile';await assert.rejects(walletIdentity(provider,store,identity.issuer,secret));token.scope=scope;
 account=null;await assert.rejects(walletIdentity(provider,store,identity.issuer,secret));account={id:'alice'};
 grant=null;await assert.rejects(walletIdentity(provider,store,identity.issuer,secret));grant={};
 token.exp=1;await assert.rejects(walletIdentity(provider,store,identity.issuer,secret));token=null;await assert.rejects(walletIdentity(provider,store,identity.issuer,secret));
 const html=authPage({uid:'id',mode:'consent',clientName:'Bot',csrf:'csrf',scope});assert.match(html,/Connect account and wallet/);assert.match(html,/Earn and spend stars/);assert.match(html,/value="deny"/);
});
test('wallet verifies the issuer, client, scopes, expiry and configured private transport, never submitted identity',async()=>{
 const options={env:{OIDC_ISSUER:identity.issuer,LIDOLLCOIN_IDENTITY_URL:'http://10.1.1.23:4180/wallet/identity'},fetcher:async(url,init)=>{assert.equal(url.hostname,'10.1.1.23');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+secret);return Response.json(identity);}};
 assert.deepEqual(await verifyWalletIdentity(secret,'lidollbot',options),identity);
 for(const patch of [{issuer:'https://evil.example'},{client_id:'other'},{scope:'openid profile'},{expires_at:1},{subject:''}])await assert.rejects(verifyWalletIdentity(secret,'lidollbot',{...options,fetcher:async()=>Response.json({...identity,...patch})}));
 await assert.rejects(verifyWalletIdentity(secret,'lidollbot',{...options,env:{OIDC_ISSUER:identity.issuer,LIDOLLCOIN_IDENTITY_URL:'http://public.example/wallet/identity'}}));
});
test('exchanging an approved login is idempotent, hashed at rest, revocable and separate from science',()=>{
 const db=new DatabaseSync(':memory:'),apps=coinApps(JSON.stringify([{id:'lidollbot',name:'Bot',origins:[],dailyLimit:100}]));
 const store=createCoinApiStore(db,()=>({coins:0,stars:0}),()=>{},()=>true,apps);
 try{const first=store.exchange('alice','lidollbot',scope,secret),again=store.exchange('alice','lidollbot',scope,secret);assert.equal(again.access_token,first.access_token);assert.equal(first.account_id,store.balance(first.access_token).account_id);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM coin_grants').get().n,1);assert.equal(JSON.stringify(db.prepare('SELECT * FROM coin_grants').all()).includes(first.access_token),false);assert.equal(JSON.stringify(db.prepare('SELECT * FROM coin_oidc_exchanges').all()).includes(secret),false);
 assert.throws(()=>store.exchange('bob','lidollbot',scope,secret));store.revoke('alice',store.connections('alice')[0].id);assert.throws(()=>store.exchange('alice','lidollbot',scope,secret),e=>e.status===401);
 }finally{db.close();}
});
