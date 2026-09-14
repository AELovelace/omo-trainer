function connectivity() {
  const offline=!navigator.onLine;
  document.getElementById('games-connection').textContent=offline?'You are offline. Your game collection is safe; reconnect to open a game.':'Games open in a separate browser tab and need an internet connection.';
  for(const link of document.querySelectorAll('[data-game-link]')) {link.setAttribute('aria-disabled',String(offline));link.classList.toggle('game-offline',offline);}
} // The cached Games page works offline, while live play and payments stay on the bot service.
for(const link of document.querySelectorAll('[data-game-link]')) link.addEventListener('click',event=>{if(!navigator.onLine){event.preventDefault();connectivity();}});
window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity);connectivity();
