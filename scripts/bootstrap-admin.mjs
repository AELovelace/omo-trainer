import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { openDatabase, databasePath } from '../server/database.mjs';

let auth,tracker;
try {
  let identity;
  if(process.argv[2]==='--verified-subject') { // Internal/server-local path used after the privileged read of the trusted identity database.
    const [subject,username,issuer]=process.argv.slice(3);
    if(!subject || !username || issuer!==process.env.OIDC_ISSUER) throw Error('Supply the trusted subject, username and the exact configured tracker issuer.');
    identity={id:subject,username};
  } else {
    const username=process.argv[2] ?? 'lid0ll';
    if(!process.env.AUTH_DATA_DIR || !process.env.AUTH_ISSUER || !process.env.OIDC_ISSUER || !process.env.DATA_DIR) throw Error('Load the existing auth and tracker environment files. AUTH_DATA_DIR, DATA_DIR and both issuer settings are required.');
    if(process.env.AUTH_ISSUER!==process.env.OIDC_ISSUER) throw Error('Auth and tracker issuers must match before assigning an administrator.');
    auth=new DatabaseSync(resolve(process.env.AUTH_DATA_DIR,'auth.sqlite'),{readOnly:true});
    identity=auth.prepare('SELECT id,username FROM accounts WHERE username=? AND disabled=0').get(username);
    if(!identity) throw Error('An enabled LiD0llID account named '+username+' was not found. No admin was assigned.');
    auth.close();auth=null;
    if(process.platform!=='win32' && process.getuid?.()===0) {
      const result=spawnSync('runuser',['-u','lidoll-tracker','--',process.execPath,'--env-file=/etc/lidoll/tracker.env',
        fileURLToPath(import.meta.url),'--verified-subject',identity.id,identity.username,process.env.OIDC_ISSUER],
        {cwd:'/',stdio:'inherit'}); // Root reads auth metadata; the tracker service user owns every SQLite write and backup.
      if(result.error) throw result.error;
      process.exit(result.status ?? 1);
    }
  }
  if(!process.env.DATA_DIR || !process.env.OIDC_ISSUER) throw Error('Load the existing tracker environment file.');
  tracker=openDatabase();
  const directory=resolve(process.env.DATA_DIR,'backups'); await mkdir(directory,{recursive:true,mode:0o700});
  const backupPath=resolve(directory,'before-admin-'+Date.now()+'.sqlite');
  await tracker.backup(backupPath); // Preserve existing records and permissions before the one-time identity binding.
  const participant=tracker.ensureParticipant(process.env.OIDC_ISSUER,identity.id,identity.username);
  tracker.admin.bootstrap(participant.id);
  console.log(JSON.stringify({username:identity.username,participantId:participant.id,role:'admin',database:databasePath(),backup:backupPath}));
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {auth?.close();tracker?.close();}
