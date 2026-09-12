    (() => {
      try {
        const savedCrtPreference = localStorage.getItem("ldq-crt-effect"); // Shares the visitor's CRT choice with the main site page.
        const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; // Respects visitors sensitive to flicker.

        if (savedCrtPreference === "off" || (savedCrtPreference === null && prefersReducedMotion)) {
          document.documentElement.classList.add("crt-disabled"); // Prevents a flash of scanlines before the stylesheet applies.
        }
      } catch (error) {
        // Privacy modes can block storage; the page keeps its normal visual default.
      }
    })();
