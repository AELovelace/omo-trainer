const css = ":root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#50193755,transparent 65%),#1a0611;color:#fff0f4;font:16px 'Segoe UI',system-ui,sans-serif;display:grid;min-height:100dvh;place-items:center;padding:24px 0}main{background:linear-gradient(135deg,#ff96c809,transparent),#260b20;border:1px solid #fadadd;box-shadow:inset 0 0 0 2px #370f2d,inset 0 0 0 3px #d89aab,7px 7px 0 #ff96c819;padding:36px;width:min(460px,calc(100% - 32px))}h1{font:italic 900 32px/1.1 'Arial Black','Segoe UI Black',sans-serif;letter-spacing:-1px;margin:24px 0 15px}p{line-height:1.8;color:#cca9bd;font-size:14px}label{display:block;margin:18px 0 8px;font:12px Consolas,monospace;color:#fadadd}input,button{width:100%;font:inherit;border:1px solid #895571;border-radius:0;padding:13px;min-height:46px}input{background:#1a0611;color:#fff0f4}button{margin-top:24px;background:#ff96c8;border-color:#ff96c8;color:#1a0611;cursor:pointer;font:700 13px Consolas,monospace}button:hover{background:#fadadd}input:focus-visible,button:focus-visible{outline:2px solid #ffe66f;outline-offset:4px}.brand{color:#ff96c8;font:700 13px Consolas,monospace;letter-spacing:1.8px}.brand span{display:block;margin-top:8px;color:#cca9bd;font-size:10px;letter-spacing:.7px}.error{color:#ffabbc;border-left:2px solid #ffabbc;padding-left:12px}small{display:block;margin-top:24px;line-height:1.7;color:#cca9bd;font-size:12px}@media(max-width:400px){main{padding:28px 24px}h1{font-size:28px}}a{color:#ff96c8;text-underline-offset:4px}a:focus-visible{outline:2px solid #ffe66f;outline-offset:4px}.help{font-size:12px;margin:8px 0 0}.switch{border-top:1px solid #72415f;padding-top:18px;margin:24px 0 0}input:invalid:not(:placeholder-shown){box-shadow:none}";

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); // Escapes client names, usernames, and validation feedback before placing them in HTML.

export function authPage({ uid, mode, clientName, csrf, error = '', username = '' }) { // Renders registration, sign-in, and consent with the shared Chrysalis identity theme.
  const register = mode === 'register', login = mode === 'login';
  const action = `/interaction/${escape(uid)}${register ? '/register' : ''}`;
  const heading = register ? 'Establish your identity.' : login ? 'Identify yourself.' : 'Authorize access.';
  const description = register ? `Create one lidoll.dev account for ${escape(clientName)} and other lidoll.dev apps. Each app has its own data and permissions.`
    : login ? `Sign in to ${escape(clientName)} with your shared LiD0llID account.`
      : `${escape(clientName)} will receive your account ID and username. Your password stays with lidoll.dev accounts.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#1a0611">
<title>${register ? 'Create account' : login ? 'Sign in' : 'Authorize access'} · lidoll.dev</title><style>${css}</style></head>
<body><main><div class="brand">✦ CHRYSALIS<span>IDENTITY GATEWAY // LiD0llID accounts</span></div>
<h1>${heading}</h1><p>${description}</p>
${error ? `<p id="form-error" class="error" role="alert">${escape(error)}</p>` : ''}
<form method="post" action="${action}"${error ? ' aria-describedby="form-error"' : ''}>
<input type="hidden" name="csrf" value="${escape(csrf)}">
${login || register ? `<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="40" value="${escape(username)}"${register ? ' minlength="3" pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]{2,39}" aria-describedby="username-help"' : ''}>
${register ? '<p class="help" id="username-help">3–40 letters, numbers, dots, underscores, or hyphens. Start with a letter or number. Stored in lowercase.</p>' : ''}
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required maxlength="128"${register ? ' minlength="12" aria-describedby="password-help"' : ''}>
${register ? '<p class="help" id="password-help">12–128 characters. A long, unique passphrase works well.</p><label for="confirm-password">Confirm password</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128">' : ''}` : ''}
<button type="submit">${register ? 'Create account' : login ? 'Sign in' : 'Continue'}</button></form>
${register ? `<p class="switch">Already registered? <a href="/interaction/${escape(uid)}">Sign in</a></p><small>No email address is collected. Save your password; password resets are handled by the lidoll.dev administrator. Next, review the app's access to your shared identity. Each app manages its own records and sync settings.</small>`
  : login ? `<p class="switch">New to LiD0llID? <a id="create-account-link" href="/interaction/${escape(uid)}/register">Create an account</a></p><small>Need a password reset? Contact the lidoll.dev administrator.</small>`
    : '<small>Each app manages access to its own data.</small>'}
</main></body></html>`;
}
