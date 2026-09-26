import { setTimeout as delay } from 'node:timers/promises';
import { readDatabaseConfig } from './config.js';
import { readAuthConfig } from './auth-config.js';
import { createDatabasePool } from './adapters/postgres/database.js';
import { assertDatabaseReady } from './adapters/postgres/migrate.js';
import { createMailTransport } from './adapters/mail/transport.js';
import { createMailWorker } from './adapters/mail/outbox.js';
import { createEmailStorage } from './modules/auth/email-storage.js';

async function main() {
  const config=readDatabaseConfig(process.env);const auth=await readAuthConfig(process.env);
  if(process.env.NODE_ENV==='production' && !['production','staging'].includes(config.identity.environment)) throw new Error('invalid_environment');
  if(!auth.mail) throw new Error('email_disabled');
  const pool=createDatabasePool(config.connectionString,2);const transport=createMailTransport(auth.mail);
  let stopped=false;const abort=new AbortController();
  const stop=()=>{stopped=true;abort.abort();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    await assertDatabaseReady(pool,config.identity);
    const worker=createMailWorker(pool,auth.cipher,transport);const storage=createEmailStorage(pool,auth.cipher,auth.pepper,()=>new Date());
    let lastCleanup=0;
    while(!stopped) {
      try {
        if(Date.now()-lastCleanup>=30_000) {await storage.cleanup();lastCleanup=Date.now();}
        await worker.tick();
      } catch {console.error('Siyue mail worker temporarily unavailable.');}
      if(!stopped) await delay(1000,undefined,{signal:abort.signal}).catch(()=>{});
    }
  } finally {transport.close();await pool.end();}
}
main().catch(()=>{console.error('Siyue mail worker startup failed; verify private configuration and schema.');process.exitCode=1;});
