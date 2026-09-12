/* Shared-account sync uses the tracker's HttpOnly session; OAuth credentials never enter this file or localStorage. */
window.createGrowthChartAccount = function (adapter) {
  "use strict";
  const endpoint = new URL(document.querySelector('meta[name="tracker-base"]').content, location.href);
  const panel = document.querySelector("#chart-account");
  const status = document.querySelector("#chart-account-status");
  const conflictPanel = document.querySelector("#chart-conflict");
  const linkButton = document.querySelector("#chart-link");
  const syncButton = document.querySelector("#chart-sync");
  const logoutButton = document.querySelector("#chart-logout");
  let session = null, conflict = null, busy = false, message = "", timer;
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
    signIn.textContent = mismatch ? "Sign in to the linked account" : "Sign in with SadGirlsClub";
    document.querySelector("#chart-register").hidden = Boolean(owner || session);
    status.textContent = message || (owner
      ? `Linked to ${owner.label}'s Chrysalis file (${owner.id}). ${dirty() || link().pending ? "Changes waiting to sync." : "Chart saved to your file."}`
      : session ? `Signed in as ${session.participant.label}. Choose whether to link this browser chart to your file.` : "This chart stays in this browser until you sign in and choose to link it.");
    linkButton.hidden = Boolean(owner || !session || session.chart);
    syncButton.hidden = !owner;
    logoutButton.hidden = !owner && !session;
    conflictPanel.hidden = !conflict || Boolean(mismatch);
    panel.querySelectorAll("button").forEach(button => { button.disabled = busy; });
    if (mismatch) syncButton.disabled = true;
  }

  async function request(route, payload) { // Use same-origin CSRF-protected API calls and keep authenticated responses out of caches.
    const response = await fetch(new URL(`api/${route}`, endpoint), {
      credentials: "same-origin", cache: "no-store", redirect: "error",
      ...(payload === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session?.csrf || "" }, body: JSON.stringify(payload) }),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error("The chart service is unavailable. Your browser chart is unchanged."); }
    if (!response.ok) throw Object.assign(new Error(result.error || "Chart sync failed."), { status: response.status });
    return result;
  }

  function checkOwner() { // A different login must never receive the previous person's queued chart.
    if (link() && link().participant.id !== session.participant.id) throw new Error("Another account is signed in. Sign in to the account linked to this chart before syncing, or export and clear this browser chart.");
  }

  function adopt(remote) { // Replace the chart only after explicit selection or a clean, linked-device refresh.
    adapter.replace({ ...remote.chart, sync: { participant: session.participant, version: remote.version, base: JSON.stringify(remote.chart), pending: null } });
    persist();
    conflict = null;
  }

  async function synchronize(choice) { // Serialize sync across chart tabs while preserving edits made during a request.
    if (busy) return;
    busy = true; message = "Checking your Chrysalis file…"; render();
    try {
      const run = async () => {
        const reviewedVersion = typeof conflict === "object" && conflict ? conflict.version : null;
        session = await request("growth-chart");
        adapter.reload();
        checkOwner();
        conflict = null;
        if ((choice === "push" || choice === "pull") && reviewedVersion !== null && session.version !== reviewedVersion) {
          conflict = session; return; // Require a new choice if the file changed again after its conflict was shown.
        }
        if (choice === "pull") {
          if (!session.chart) throw new Error("There is no saved chart to load yet.");
          adopt(session);
        } else if (choice === "push" || choice === "link") {
          if (choice === "link" && session.chart) { conflict = session; return; }
          adapter.get().sync = { participant: session.participant, version: session.version, base: null, pending: null };
          persist(); // First upload and replacing a conflicting file both require the visitor's explicit button choice.
          conflict = null;
        }
        if (!link()) { conflict = session.chart ? session : null; return; }
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = link();
          if (!current.pending && !dirty()) {
            if (session.version !== current.version && session.chart) adopt(session);
            return;
          }
          if (!current.pending) {
            if (session.version !== current.version) { conflict = session; return; }
            current.pending = { mutationId: crypto.randomUUID(), baseVersion: current.version, chart: snapshot() };
            persist();
          }
          const pending = structuredClone(current.pending);
          const saved = await request("growth-chart", pending);
          adapter.reload();
          checkOwner();
          if (saved.participant.id !== link()?.participant.id || link()?.pending?.mutationId !== pending.mutationId) return;
          link().version = saved.version;
          link().base = JSON.stringify(pending.chart); // A newer edit remains dirty after an older in-flight save succeeds.
          link().pending = null;
          persist();
          session = await request("growth-chart"); // Observe another device's changes after a lost-response retry.
          adapter.reload(); checkOwner();
        }
      };
      if (navigator.locks) await navigator.locks.request("ldq-growth-chart-sync", run);
      else await run();
      message = conflict ? "A chart is already in your file. Choose which complete chart to keep; replacing one does not merge its stars or rows." : "";
    } catch (error) {
      if (error.status === 401) {
        session = null;
        message = "Sign in to link or resume chart sync. Your browser chart and pending changes are retained.";
      } else if (error.status === 409) {
        conflict = true;
        message = "Your file changed on another device. Export a copy if needed, then choose which complete chart to keep.";
      } else message = error instanceof TypeError ? "The chart service could not be reached. Your chart and pending edits stay in this browser; sync will retry when connected." : error.message;
    } finally { busy = false; render(); }
  }

  document.querySelector("#chart-sign-in").href = new URL("auth/login?returnTo=growth-chart", endpoint).href;
  document.querySelector("#chart-register").href = new URL("auth/register?returnTo=growth-chart", endpoint).href;
  document.querySelector("#chart-tracker").href = endpoint.href;
  linkButton.addEventListener("click", () => synchronize("link"));
  syncButton.addEventListener("click", () => synchronize());
  document.querySelector("#chart-use-file").addEventListener("click", () => synchronize("pull"));
  document.querySelector("#chart-use-device").addEventListener("click", () => synchronize("push"));
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
      adapter.clear(); persist(); session = null; conflict = null; message = "Signed out. This browser chart has been cleared.";
    } catch (error) { message = error.message; }
    finally { busy = false; render(); }
  });
  window.addEventListener("online", () => synchronize());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) synchronize(); });
  setInterval(() => { if (!document.hidden && navigator.onLine) synchronize(); }, 30000);
  render();
  return {
    start: () => synchronize(),
    changed() { // Debounce edits while keeping their content and previous retry receipt in the same browser save.
      clearTimeout(timer);
      if (link()) timer = setTimeout(() => synchronize(), 700);
      render();
    },
  };
};
