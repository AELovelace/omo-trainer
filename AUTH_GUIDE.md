# Shared lidoll.dev authentication

The identity service is a separate Node process intended for **https://auth.lidoll.dev**. It implements OpenID Connect through [oidc-provider](https://github.com/panva/node-oidc-provider). Little Log uses [openid-client](https://github.com/panva/openid-client) as a relying party. The code is pinned in `package-lock.json`.

All applications use the same issuer and stable account subject. Each application has its own registered client ID, exact callback URLs, session cookies, database, and authorization rules. Logging in to a second registered app reuses the auth server's existing login session. Signing in does not grant an app access to another app's records.

## Start locally

Install Node 24 or newer, then run `npm ci`. On Windows use `npm.cmd ci` if PowerShell blocks `npm.ps1`.

```sh
node scripts/auth-admin.mjs init
node scripts/auth-admin.mjs create alice
node scripts/auth-server.mjs
```

The create command generates a strong password and displays it once. Share credentials privately; passwords are never accepted as shell arguments. Run `node scripts/serve.mjs` in another terminal and open **http://127.0.0.1:4173/tracker/**. Choose **Settings & data → Sign in with lidoll.dev**.

Default local issuer: `http://127.0.0.1:4180`. Default client: `little-log`. Default callback: `http://127.0.0.1:4173/tracker/auth/callback`. Use these exact hostnames consistently: `localhost` and `127.0.0.1` are different cookie origins.

## Production configuration

For the Fedora service host, [FEDORA_DEPLOYMENT.md](FEDORA_DEPLOYMENT.md) provides the dnf installer, systemd setup, GitHub updater, and backup/rollback workflow. It creates separate `lidoll-auth` and `lidoll-tracker` Unix users; run admin commands as the matching service user to preserve database file ownership. Auth keys and accounts stay outside release checkouts across updates.

Use separate environment files based on [auth.env.example](deploy/auth.env.example) and [tracker.env.example](deploy/tracker.env.example). Provision the two persistent directories with access restricted to the service user. Run under your process manager:

```sh
node --env-file=/etc/lidoll/auth.env scripts/auth-server.mjs
node --env-file=/etc/lidoll/tracker.env scripts/serve.mjs
```

Run auth administrator commands with the **same auth environment file**. Initialization writes `clients.json` only if it does not exist. Changing `TRACKER_REDIRECT_URI` later does not overwrite existing clients; update the callback in that file and restart auth.

On the reverse-proxy server, configure DNS and HTTPS for `auth.lidoll.dev`, then include [nginx-auth.conf](deploy/nginx-auth.conf) inside that HTTPS server block. Keep the tracker proxy inside the existing `lidoll.dev` HTTPS block. The snippets preserve the configured service address `10.1.1.23`, using ports 4173 and 4180. Only the reverse proxy should reach those service ports. `AUTH_TRUST_PROXY=1` trusts the proxy's scheme/IP headers, so the proxy must replace `X-Real-IP` and the service must not be directly reachable by clients.

Production startup requires explicit HTTPS issuer/app URLs. Auth metadata is available at `https://auth.lidoll.dev/.well-known/openid-configuration`. Avoid changing the issuer after accounts are in use: the combination of issuer and subject identifies an account to applications.

## Add another application

```sh
node --env-file=/etc/lidoll/auth.env scripts/auth-admin.mjs add-client my-next-app https://next.lidoll.dev/auth/callback
```

Restart the auth service after editing client configuration. Configure the new application with:

| Setting | Value |
| --- | --- |
| Issuer | `https://auth.lidoll.dev` |
| Client ID | Its unique registered ID, such as `my-next-app` |
| Scopes | `openid profile` |
| Flow | Authorization code, mandatory PKCE S256 |
| Client authentication | `none` for the supplied public-client registration |
| Callback | The exact registered HTTPS URL |
| Identity key | Verified `iss` plus `sub`, never username |

Use an OIDC client library, generate a new PKCE verifier/state/nonce for each login, store them server-side, and validate the response and ID-token signature. [server/login.mjs](server/login.mjs) is the working integration example. Redirects are allowlisted; dynamic registration, implicit flows, and password grants are not enabled. Register additional callback URLs explicitly rather than using wildcards.

Applications should issue their own host-only HttpOnly/Secure session cookies. Do not set a broad `.lidoll.dev` cookie containing a shared bearer token. App permissions remain local to each app; this version supplies shared identity, not a universal administrator role or shared API-access scopes.

## Account administration and persistence

```sh
node scripts/auth-admin.mjs list
node scripts/auth-admin.mjs reset-password alice
node scripts/auth-admin.mjs disable alice
node scripts/auth-admin.mjs backup backups/auth-2026-09-11
```

The auth directory contains `auth.sqlite`, persistent signing/cookie keys in `secrets.json`, and registered apps in `clients.json`. The backup command captures the live SQLite database using its backup API and includes both configuration files in a new directory. Keep that directory private. To restore, stop the auth service, restore the complete matching backup into its auth data directory, retain the public issuer, and restart. A restored old backup may restore old sessions; plan account/session revocation accordingly.

Passwords use salted scrypt. Login attempts are limited per username and source IP, with counters stored in SQLite. The provider persists sessions, authorization grants, tokens, code consumption, and expiry. PKCE, callback validation, state, nonce, and signed ID tokens are handled through the OIDC libraries.

This release uses administrator-provisioned username/password accounts and administrator password resets. It does not yet include self-registration, email delivery/recovery, MFA/passkeys, or a web admin console. Shared login sessions last up to seven days. Little Log sessions expire after one hour and can reauthenticate through shared login. Disabling an account or resetting its password removes auth-service sessions; existing application sessions expire on their own schedule (up to one hour for Little Log).

**Sign out & clear device** ends Little Log's session and clears its browser records; it does not sign out every other application or end the shared auth login. Global app-session revocation/back-channel logout is not implemented. Treat these lifetime and logout semantics as part of the contract when integrating future apps.
