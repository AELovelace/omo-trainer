// Returning players already approved wallet access; finish the protected form automatically.
const form=document.querySelector('#game-consent');
if(form?.dataset.approved==='true')form.requestSubmit(document.querySelector('#allow'));
