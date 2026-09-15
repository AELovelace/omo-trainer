import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGamesRoute} from '../server/games.mjs';

test('Games redirects fixed names to the configured HTTPS bot, never forwarding credentials or return URLs',()=>{
  const route=createGamesRoute('/tracker/',{LIDOLLBOT_PUBLIC_ORIGIN:'https://bot.example',NODE_ENV:'production'});
  for(const game of ['diapers','hangman','touhou','balldrop'])for(const method of ['GET','HEAD']){
    const headers={},res={setHeader:(key,value)=>headers[key]=value,writeHead:(status,values)=>{res.status=status;Object.assign(headers,values);},end:()=>{}};
    assert.equal(route({method,url:`/tracker/games/${game}?token=secret&returnTo=https://evil.example`,headers:{cookie:'secret'}},res,`/tracker/games/${game}`),true);
    assert.equal(res.status,303);assert.equal(headers.Location,`https://bot.example/${game}/login`);assert.equal(headers['Cache-Control'],'no-store');assert.equal(headers['Set-Cookie'],undefined);
  }
  const res={setHeader(){},writeHead(status){this.status=status;},end(){}};
  route({method:'POST'},res,'/tracker/games/touhou');assert.equal(res.status,405);
  route({method:'GET'},res,'/tracker/games/unknown');assert.equal(res.status,404);
  assert.equal(route({method:'GET'},res,'/tracker/api/me'),false);
});
test('Games origin rejects insecure production, embedded credentials and arbitrary paths',()=>{
  for(const value of ['http://bot.example','https://bot.example/evil','https://user:pass@bot.example','https://bot.example?token=a','https://bot.example/#x','http://127.0.0.1:4000'])assert.throws(()=>createGamesRoute('/',{LIDOLLBOT_PUBLIC_ORIGIN:value,NODE_ENV:'production'}));
  assert.doesNotThrow(()=>createGamesRoute('/',{LIDOLLBOT_PUBLIC_ORIGIN:'http://127.0.0.1:4000',NODE_ENV:'test'}));
});
test('Games shell offers all four separate tabs with link instructions and a cached offline module',()=>{
  const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8'),html=read('index.html');
  for(const game of ['diapers','hangman','touhou','balldrop'])assert.match(html,new RegExp(`href="./games/${game}" target="_blank" rel="noopener noreferrer"`));
  assert.match(html,/No Discord account or membership is needed/);assert.doesNotMatch(html,/<iframe/i);assert.match(read('sw.js'),/\.\/lib\/games.js/);
  assert.match(read('scripts/serve.mjs'),/createGamesRoute/);assert.match(read('app.js'),/import '\.\/lib\/games.js'/);
});
