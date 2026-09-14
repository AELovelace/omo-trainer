import { workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database.mjs';
import { runAnalysisJob } from './ai-analysis.mjs';

const database=openDatabase(workerData.filename),store=database.aiAnalysis,owner=randomUUID();
let running=false;
async function tick() { // A dedicated thread handles aggregation and long HTTP calls without occupying the app request loop.
  try{store.schedule();}catch{console.error('AI analysis schedule could not be checked. It will retry.');}
  if(running)return;running=true;
  try{const job=store.claim(owner);if(job)await runAnalysisJob(store,job,owner);}
  catch{console.error('AI analysis worker could not process the queue. It will retry.');}
  finally{running=false;}
}
setInterval(()=>void tick(),5000); // Check persisted work and the Los Angeles date boundary even with no administrator connected.
void tick();
