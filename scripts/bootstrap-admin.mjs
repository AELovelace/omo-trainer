import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDatabase, databasePath } from '../server/database.mjs';

const username=process.argv[2] ?? 'lid0ll';
let auth,tracker;
try {
  if(!process.env.AUTH_DATA_DIR || !process.env.AUTH_ISSUER || !process.env.OIDC_ISSUER || !process.env.DATA_DIR) throw Error('Load the existing auth and tracker environment files. AUTH_DATA_DIR, DATA_DIR and both issuer settings are required.');
  if(process.env.AUTH_ISSUER!==process.env.OIDC_ISSUER) throw Error('Auth and tracker issuers must match before assigning an administrator.');
  auth=new DatabaseSync(resolve(process.env.AUTH_DATA_DIR,'auth.sqlite'),{readOnly:true});
  const identity=auth.prepare('SELECT id,username FROM accounts WHERE username=? AND disabled=0').get(username);
  if(!identity) throw Error('An enabled LidollID account named '+username+' was not found. No admin was assigned.');
  auth.close();auth=null;
  tracker=openDatabase();
  const directory=resolve(process.env.DATA_DIR,'backups'); await mkdir(directory,{recursive:true,mode:0o700});
  const backupPath=resolve(directory,'before-admin-'+Date.now()+'.sqlite');
  await tracker.backup(backupPath); // Preserve existing records and permissions before the one-time identity binding.
  const participant=tracker.ensureParticipant(process.env.OIDC_ISSUER,identity.id,identity.username);
  tracker.admin.bootstrap(participant.id);
  console.log(JSON.stringify({username:identity.username,participantId:participant.id,role:'admin',database:databasePath(),backup:backupPath}));
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {auth?.close();tracker?.close();}
