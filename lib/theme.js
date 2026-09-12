const themes={'little-tracker':{name:'Little Tracker',color:'#fff5fa',description:'Soft pastels, rounded cards and a sprinkle of everyday cheer.'},'caregiver-tracker':{name:'Caregiver Tracker',color:'#1a0611',description:'The original Chrysalis terminal: dark plum, pink accents and crisp frames.'}};
const selector=document.querySelector('#theme-selector'),status=document.querySelector('#theme-status');
function applyTheme(value,message) { // Change only appearance: mounted forms, saved records and account sessions stay in place.
  const key=Object.hasOwn(themes,value)?value:'little-tracker',theme=themes[key];
  document.documentElement.dataset.theme=key;document.querySelector('meta[name="theme-color"]').content=theme.color;
  selector.value=key;document.querySelector('#theme-description').textContent=theme.description;
  status.textContent=message??theme.name+' is selected.';
  window.dispatchEvent(new Event('little-log-theme-changed'));
}
selector.addEventListener('change',()=>{ // Save the choice on this device without putting a cosmetic preference into scientific exports.
  const key=selector.value;let message=themes[key].name+' saved on this device.';
  try {localStorage.setItem('little-log.theme',key);}catch {message='Theme applied for this visit. Your browser could not save the preference.';}
  applyTheme(key,message);
});
window.addEventListener('storage',event=>{if(event.key==='little-log.theme'||event.key===null)applyTheme(event.newValue);}); // Keep open tabs consistent without reloading unfinished forms.
applyTheme(document.documentElement.dataset.theme);
