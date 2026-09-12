/* Shared-account sync uses the tracker's HttpOnly session; OAuth credentials never enter this file or localStorage. */
window.createGrowthChartAccount = function (adapter) {
  "use strict";
  const endpoint = new URL(document.querySelector('meta[name="tracker-base"]').content, location.href);
  const panel = document.querySelector("#chart-account");
  const status = document.querySelector("#chart-account-status");

  const syncButton = document.querySelector("#chart-sync");
  const logoutButton = document.querySelector("#chart-logout");
  let session = null, busy = false, message = "", timer, again = false, retryDelay = 1500, sessionEpoch = 0;
  const updates = typeof BroadcastChannel === "function" ? new BroadcastChannel("little-log-chart-updates") : null;
  const snapshot = () => {
    const { name, stars, rows, refusals, escaped, since } = adapter.get();
    return structuredClone({ name, stars, rows, refusals, escaped, since }); // Send chart content only; sync ownership stays in the local envelope.
  };
  const link = () => adapter.get().sync;
  const dirty = () => Boolean(link() && JSON.stringify(snapshot()) !== link().base);

  function persist() { // Never upload a mutation unless its retry ID and content were saved together successfully.
    if (!adapter.persist()) throw new Error("Browser storage is unavailable. This chart cannot sync until it can save its upload queue.");
  }

  function render() { // Keep actual account/storage status separate from the fictional nursery copy.
    const owner = link()?.participant;
    const mismatch = owner && session && owner.id !== session.participant.id;
    const signIn = document.querySelector("#chart-sign-in");
    signIn.hidden = Boolean(session && !mismatch);
    signIn.href = new URL(`auth/login?returnTo=growth-chart${mismatch ? "&reauth=1" : ""}`, endpoint).href;
    signIn.textContent = mismatch ? "Sign in to the linked account" : "Sign in with LiD0llID";
    document.querySelector("#chart-register").hidden = Boolean(owner || session);
    status.textContent = message || (owner
      ? `Linked to ${owner.label}'s Chrysalis file (${owner.id}). ${dirty() || link().pending ? "Changes waiting to sync." : "Chart saved to your file."}`
      : session ? `Signed in as ${session.participant.label}. Linking this chart to your file…` : "Sign in with LiD0llID to automatically link and sync this chart.");
    syncButton.hidden = !owner;
    logoutButton.hidden = adapter.embedded || (!owner && !session); // Embedded charts use the app's Settings account controls.
    document.querySelector("#chart-tracker").hidden = Boolean(adapter.embedded);

    panel.querySelectorAll("button").forEach(button => { button.disabled = busy; });
    if (mismatch) syncButton.disabled = true;
    if(adapter.embedded) window.dispatchEvent(new CustomEvent('little-log-chart-status',{detail:{
      connected:Boolean(owner && session && !mismatch),
      text:busy?'Syncing potty chart...':!session?'Chart saved on this device':mismatch || message?'Chart sync needs attention':owner?(dirty() || link().pending?'Chart changes waiting to sync':'Chart saved to Chrysalis file'):'Chart saved on this device'
    }})); // Let the shared app header describe the view currently being used.
  }

  async function request(route, payload) { // Use same-origin CSRF-protected API calls and keep authenticated responses out of caches.
    const epoch=sessionEpoch; // Ignore network responses belonging to a session cleared through Little Log Settings.
    const response = await fetch(new URL(`api/${route}`, endpoint), {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
      ...(payload === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session?.csrf || "" }, body: JSON.stringify(payload) }),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error("The chart service is unavailable. Your browser chart is unchanged."); }
    if(epoch!==sessionEpoch) throw Object.assign(new Error("The app session changed."),{status:401});
    if (!response.ok) throw Object.assign(new Error(result.error || "Chart sync failed."), { status: response.status });
    return result;
  }

  function checkOwner() { // A different login must never receive the previous person's queued chart.
    if (link() && link().participant.id !== session.participant.id) throw new Error("Another account is signed in. Sign in to the account linked to this chart before syncing, or export and clear this browser chart.");
  }

  function adopt(remote) { // Clean devices restore the server chart without making another save.
    adapter.replace({ ...remote.chart, sync: { participant: session.participant, version: remote.version, base: JSON.stringify(remote.chart), pending: null } });
    persist();
  }
  function reconcile(remote, initial=false) { // Replay only unsynced edits over the newest version, preserving unrelated rows and dated stars.
    const base=initial?adapter.blank():JSON.parse(link().base || JSON.stringify(adapter.blank()));
    const chart=window.mergeGrowthCharts({base,local:snapshot(),remote:remote.chart,initial});
    adapter.replace({...chart,sync:{participant:session.participant,version:remote.version,base:JSON.stringify(remote.chart),pending:null}});
    persist();
  }
  function schedule(delay=700) { clearTimeout(timer); timer=setTimeout(()=>synchronize(),delay); }
  async function synchronize() { // Serialize requests, retain retry receipts, and rebase automatically when another device saves first.
    if(busy) { again=true; return; }
    clearTimeout(timer); busy=true; again=false; message="Saving and checking your Chrysalis file..."; render();
    let retry=false;
    try {
      const run=async()=>{
        session=await request("growth-chart"); adapter.reload(); checkOwner();
        if(!link()) {
          if(session.chart && adapter.isBlank()) adopt(session);
          else if(session.chart) reconcile(session,true);
          else { adapter.get().sync={participant:session.participant,version:session.version,base:null,pending:null}; persist(); }
        }
        if(link().needsChoice) reconcile(session,true); // Upgrade previously paused first-link charts without dropping either copy.
        for(let attempt=0;attempt<5;attempt++) {
          const current=link();
          if(!current.pending) {
            if(session.version!==current.version && session.chart) {
              if(dirty()) reconcile(session); else adopt(session);
            }
            if(!dirty()) return;
            link().pending={mutationId:crypto.randomUUID(),baseVersion:link().version,chart:snapshot()};
            persist();
          }
          const pending=structuredClone(link().pending);
          let saved;
          try { saved=await request("growth-chart",pending); }
          catch(error) {
            if(error.status!==409) throw error;
            session=await request("growth-chart"); adapter.reload(); checkOwner();
            if(link()?.pending?.mutationId===pending.mutationId) reconcile(session);
            continue; // A rejected old version is merged and retried, never replaced wholesale.
          }
          adapter.reload(); checkOwner();
          if(saved.participant.id!==link()?.participant.id || link()?.pending?.mutationId!==pending.mutationId) { again=true; return; }
          link().version=saved.version; link().base=JSON.stringify(pending.chart); link().pending=null;
          persist(); updates?.postMessage({participantId:saved.participant.id,version:saved.version});
          session=await request("growth-chart"); adapter.reload(); checkOwner();
        }
        again=true;
      };
      if(navigator.locks) await navigator.locks.request("ldq-growth-chart-sync",run); else await run();
      message=""; retryDelay=1500;
    } catch(error) {
      if(error.status===401) { session=null; message="Sign in to resume automatic sync. Your chart and pending edits are retained."; }
      else {
        retry=!error.status || error.status>=500 || error.status===403 || error.status===409;
        message=retry?"Changes are saved in this browser. Automatic sync will retry shortly. "+error.message:error.message;
      }
    } finally {
      busy=false; render();
      if(retry) { schedule(retryDelay); retryDelay=Math.min(retryDelay*2,30000); }
      else if(again) schedule(700); // An edit made during a request must not wait for the next polling interval.
    }
  }

  document.querySelector("#chart-sign-in").href = new URL("auth/login?returnTo=growth-chart", endpoint).href;
  document.querySelector("#chart-register").href = new URL("auth/register?returnTo=growth-chart", endpoint).href;
  document.querySelector("#chart-tracker").href = endpoint.href;
  syncButton.addEventListener("click", () => synchronize());
  document.querySelector("#chart-backup").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "growth-chart.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); // Export chart content without cookies, CSRF tokens, or account identifiers.
  });
  logoutButton.addEventListener("click", async () => {
    if (!confirm("Sign out of Little Log and clear this browser chart? Pending chart changes will be lost. Your saved Chrysalis file stays on the server.")) return;
    busy = true; render();
    try {
      try { session = await request("growth-chart"); await request("logout", {}); }
      catch (error) { if (error.status !== 401) throw error; }
      sessionEpoch++; adapter.clear(); persist(); session = null; message = "Signed out. This browser chart has been cleared.";
    } catch (error) { message = error.message; }
    finally { busy = false; render(); }
  });
  window.addEventListener("little-log-signout",()=>{
    if(!adapter.embedded) return;
    sessionEpoch++; clearTimeout(timer); again=false; session=null; adapter.clear(); persist(); message="Signed out. Your saved chart remains in your Chrysalis file."; render();
  });
  window.addEventListener("online", () => synchronize());
  window.addEventListener("pageshow", () => synchronize());
  window.addEventListener("little-log-chart-visible", () => synchronize());
  window.addEventListener("storage", event => { if(event.key === "ldq-growth-chart-v2") schedule(150); });
  if(updates) updates.onmessage=event=>{ if(event.data?.participantId===link()?.participant.id && event.data.version>link().version) schedule(150); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) synchronize(); });
  setInterval(() => { if (!document.hidden && navigator.onLine) synchronize(); }, 15000);
  render();
  return {
    start: () => synchronize(),
    changed() { // Debounce edits while keeping their content and previous retry receipt in the same browser save.
      clearTimeout(timer);
      if (link() || session) schedule();
      render();
    },
  };
};
