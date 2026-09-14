export function createRewardCelebration(dialog, layer, soundButton, reducedMotion) { // Keep visual/audio feedback independent of saving and awarding the actual sticker.
  const key='little-log.reward-sound';
  let enabled=true, audio=null;
  const tones=new Set();
  try { enabled=localStorage.getItem(key)!=='off'; } catch { /* Sound still works when preference storage is unavailable. */ }
  function renderSound() {
    soundButton.textContent=enabled?'Sound on':'Sound off';
    soundButton.setAttribute('aria-pressed',String(enabled));
    soundButton.setAttribute('aria-label','Sticker celebration sound');
  }
  function prepare() { // Unlock audio during the save or retry gesture, before the asynchronous sticker receipt arrives.
    if(!enabled)return;
    try {
      const Audio=window.AudioContext||window.webkitAudioContext;
      if(!Audio)return;
      audio??=new Audio();
      if(audio.state==='suspended')void audio.resume().catch(()=>{});
    } catch { /* Audio support or autoplay restrictions must never interrupt a check-in. */ }
  }
  function clearConfetti() {
    for(const piece of layer.children)for(const animation of piece.getAnimations())animation.cancel();
    layer.replaceChildren();
  }
  function stopSound() {
    for(const tone of tones){try{tone.stop();}catch{}tone.disconnect();}
    tones.clear();
  }
  function play() { // A short pastel burst and quiet major chord celebrate only the sticker currently visible in this dialog.
    if(!dialog.open||document.hidden)return;
    clearConfetti();
    if(!reducedMotion.matches) {
      const colors=['var(--pastel-pink, #ff96c8)','var(--pastel-lilac, #bba1db)','var(--pastel-mint, #a8dccc)','var(--pastel-yellow, #ffe6a0)'];
      for(let i=0;i<36;i++) {
        const piece=document.createElement('span');piece.style.background=colors[i%colors.length];layer.append(piece);
        const x=(Math.random()-.5)*dialog.clientWidth*1.4,y=110+Math.random()*230,rotation=(Math.random()-.5)*720;
        const animation=piece.animate([{transform:'translate(0,0) rotate(0deg)',opacity:1},{transform:'translate('+x*.6+'px,-65px) rotate('+rotation*.4+'deg)',opacity:1,offset:.35},{transform:'translate('+x+'px,'+y+'px) rotate('+rotation+'deg)',opacity:0}],{duration:1100+Math.random()*500,easing:'cubic-bezier(.2,.65,.4,1)',fill:'forwards'});
        void animation.finished.catch(()=>{}).finally(()=>piece.remove());
      }
    }
    if(!enabled||audio?.state!=='running')return;
    try {
      const start=audio.currentTime;
      for(const [i,frequency] of [523.25,659.25,783.99].entries()) {
        const tone=audio.createOscillator(),gain=audio.createGain(),at=start+i*.09;
        tone.type='sine';tone.frequency.value=frequency;
        gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(.045,at+.015);gain.gain.exponentialRampToValueAtTime(.001,at+.25);
        tone.connect(gain);gain.connect(audio.destination);tones.add(tone);
        tone.onended=()=>{tones.delete(tone);tone.disconnect();gain.disconnect();};
        tone.start(at);tone.stop(at+.27);
      }
    } catch { stopSound(); }
  }
  soundButton.addEventListener('click',()=>{
    enabled=!enabled;renderSound();
    try {localStorage.setItem(key,enabled?'on':'off');}catch{}
    if(enabled)prepare();else stopSound();
  });
  reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches)clearConfetti();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearConfetti();stopSound();}});
  renderSound();
  return {prepare,play,clear(){clearConfetti();stopSound();}};
}
