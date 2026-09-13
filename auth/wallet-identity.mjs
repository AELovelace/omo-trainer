export const walletScopes=['wallet:read','wallet:write','stars:read','stars:write'];

export async function walletIdentity(provider,store,issuer,secret) { // Only the issuer can establish which client and account approved these wallet permissions.
  if(typeof secret!=='string'||secret.length>4096)throw Error('Invalid access token');
  const token=await provider.AccessToken.find(secret);
  if(!token||!token.accountId||!token.grantId||token.exp<=Math.floor(Date.now()/1000))throw Error('Expired access token');
  const account=store.account(token.accountId),grant=await provider.Grant.find(token.grantId);
  const scope=walletScopes.filter(value=>String(token.scope).split(' ').includes(value));
  if(!account||!grant||!scope.length)throw Error('Wallet consent required');
  return {issuer,subject:account.id,username:account.username,client_id:token.clientId,scope:scope.join(' '),expires_at:token.exp};
}
