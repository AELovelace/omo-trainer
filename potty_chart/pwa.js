/* Installation affects the public chart shell only; saved stars stay in the existing browser key. */
(() => {
  "use strict";
  const button = document.querySelector("#install-chart");
  const status = document.querySelector("#offline-status");
  let installPrompt = null; // Browsers supply this event only when installation is available.

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // Wait for the visitor to choose the visible install button.
    installPrompt = event;
    button.hidden = false;
  });

  button.addEventListener("click", async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null; // Each browser prompt can be consumed only once.
    button.hidden = true;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      status.textContent = "Use your browser's Install app or Add to Home Screen option to install this chart.";
    }
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    button.hidden = true; // Hide the invitation once the browser confirms installation.
  });

  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    status.textContent = "Offline installation needs HTTPS or localhost. Your chart still works in this browser.";
    return;
  }

  const inTracker = Boolean(document.querySelector('meta[name="chart-in-tracker"]')); // Bundled charts share Little Log's existing worker and installation identity.
  navigator.serviceWorker.register(inTracker ? "../sw.js" : "./sw.js", { scope: inTracker ? "../" : "./", updateViaCache: "none" }).then((registration) => {
    function report(worker) { // Report readiness only after the complete public shell is installed.
      if (worker.state === "activated") {
        status.textContent = "Chart ready offline. Install using your browser menu; on iPhone or iPad, use Safari → Share → Add to Home Screen. Game links need a connection.";
      } else if (worker.state === "installed" && registration.active) {
        status.textContent = "Chart update ready. Close all chart tabs and reopen to use it.";
      } else if (worker.state === "redundant") {
        status.textContent = "Offline setup did not finish. Reconnect and reload to try again.";
      }
    }
    function watch(worker) { // Follow first installation and subsequent updates without forcing a reload during an edit.
      if (!worker) return;
      report(worker);
      worker.addEventListener("statechange", () => report(worker));
    }
    watch(registration.active);
    watch(registration.waiting);
    watch(registration.installing);
    registration.addEventListener("updatefound", () => watch(registration.installing));
  }).catch(() => {
    status.textContent = "Offline setup did not finish. Reconnect and reload to try again.";
  });
})();
