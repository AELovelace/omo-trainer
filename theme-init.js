(() => { // Apply the saved appearance before styles paint, including offline launches and blocked storage.
  let theme='little-tracker';
  try {const saved=localStorage.getItem('little-log.theme');if(['little-tracker','caregiver-tracker'].includes(saved))theme=saved;}catch { /* Use the pastel default when device storage is unavailable. */ }
  document.documentElement.dataset.theme=theme;
  document.querySelector('meta[name="theme-color"]').content=theme==='little-tracker'?'#fff5fa':'#1a0611';
})();
