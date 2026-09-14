import { Worker } from 'node:worker_threads';

export function startAnalysisWorker(filename) { // Restart a crashed worker while letting SQLite leases protect jobs from duplicate completion.
  let stopped=false,worker=null,restart=null;
  function start(){
    if(stopped)return;
    worker=new Worker(new URL('./ai-analysis-worker.mjs',import.meta.url),{workerData:{filename},execArgv:[]}); // Environment is inherited; process-only CLI and test-runner flags are not valid worker options.
    worker.on('error',()=>console.error('AI analysis worker stopped unexpectedly; restarting.'));
    worker.on('exit',()=>{if(!stopped){restart=setTimeout(start,5000);restart.unref();}});
    worker.unref();
  }
  start();
  return ()=>{stopped=true;clearTimeout(restart);void worker?.terminate();}; // Shutdown releases the worker connection; unfinished jobs recover after the 90-second lease expires.
}
