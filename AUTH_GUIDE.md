# Shared LiD0llID authentication

The identity service is a separate Node process intended for **https://auth.sadgirlsclub.wtf**. It implements OpenID Connect through [oidc-provider](https://github.com/panva/node-oidc-provider). Little Log uses [openid-client](https://github.com/panva/openid-client) as a relying party. The code is pinned in `package-lock.json`.

All applications use the same issuer and stable account subject. Each application has its own registered client ID, exact callback URLs, session cookies, database, and authorization rules. Logging in to a second registered app reuses the auth server's existing login session. Signing in does not grant an app access to another app's records.

Registration, sign-in, and consent screens use the Chrysalis identity-gateway theme. The client name, requested identity access, account instructions, and errors remain explicit; the visual theme does not change issuer URLs, account IDs, or client registrations.

## Start locally

Install Node 24 or newer, then run `npm ci`. On Windows use `npm.cmd ci` if PowerShell blocks `npm.ps1`.

```sh
node scripts/auth-admin.mjs init
node scripts/auth-admin.mjs create alice
node scripts/auth-server.mjs
```

The create command generates a strong password and displays it once. Share credentials privately; passwords are never accepted as shell arguments. Run `node scripts/serve.mjs` in another terminal and open **http://127.0.0.1:4173/tracker/**. Choose **Settings & data → Sign in with LiD0llID**.

Default local issuer: `http://127.0.0.1:4180`. Default client: `little-log`. Default callback: `http://127.0.0.1:4173/tracker/auth/callback`. Use these exact hostnames consistently: `localhost` and `127.0.0.1` are different cookie origins.

## Self-service registration

**Announcement link:** https://auth.sadgirlsclub.wtf/register

This permanent URL starts a fresh signup flow on every visit. It redirects to
Little Log's registration entry point, derived from its registered callback in
clients.json, which establishes PKCE, state, nonce and login cookies before
showing the shared LiD0llID signup form. Visitors do not need to open Little Log
first. After signup and consent, they arrive at Little Log's account settings.
The existing 18+ confirmation and registration protections apply. Query parameters
cannot override the destination. Use the permanent link in announcements rather
than copying a temporary /interaction/ URL. Locally, use http://127.0.0.1:4180/register.
Deploy the updated auth service and restart lidoll-auth to enable the short link;
the registered Little Log service must also be available.

Choose **Settings & data → Create account** in Little Log, or **Register for LiD0llID** on the shared sign-in page. Registration asks for a username, password, password confirmation, and an unchecked **I confirm I am 18 or older** checkbox. Adult confirmation is required by both the browser and the registration endpoint before an account is created. This is self-attestation; no date of birth or identity documents are collected. Usernames are normalized to lowercase and must contain 3–40 letters, numbers, dots, underscores, or hyphens, starting with a letter or number. Passwords must contain 12–128 characters. No email address is collected or email verification performed; password resets remain administrator-managed.

Little Log starts registration at `/tracker/auth/register`. This creates a normal server-side OIDC login attempt with PKCE, state, and nonce, using `screen_hint=signup` and `prompt=login` to request the auth service's registration screen. The form lives at `/interaction/<uid>/register` and requires the matching, unexpired interaction cookie. Do not bookmark or publish an interaction URL. Future registered apps can request the same signup hint using their own client and callback.

Successful registration signs into the shared identity service and proceeds through app consent. From Little Log's **Create account** button, existing local entries remain on the device until **Connect & upload my entries** is selected. Someone who follows **Register for LiD0llID** during an already-started sign-in/connect flow continues that original connection request. Account creation itself never grants access to another participant's records.

Registration is enabled for visitors after deploying this version; no new environment variables, ports, Nginx locations, or schema migration are required. Deploy both Node services and the frontend together. Duplicate usernames, including disabled accounts, cannot be overwritten. Registration POSTs require a matching Origin, interaction cookie, and action-bound CSRF token. Responses are not cached and never redisplay submitted passwords. Attempts are limited to 10 per source IP and 60 globally per 15 minutes, persisted in SQLite, with at most four concurrent registration password hashes per auth process. The proxy must supply the real client IP using the existing trusted-proxy configuration.

## Production configuration

For the Fedora service host, [FEDORA_DEPLOYMENT.md](FEDORA_DEPLOYMENT.md) provides the dnf installer, systemd setup, GitHub updater, and backup/rollback workflow. It creates separate `lidoll-auth` and `lidoll-tracker` Unix users; run admin commands as the matching service user to preserve database file ownership. Auth keys and accounts stay outside release checkouts across updates.

Use separate environment files based on [auth.env.example](deploy/auth.env.example) and [tracker.env.example](deploy/tracker.env.example). Provision the two persistent directories with access restricted to the service user. Run under your process manager:

```sh
node --env-file=/etc/lidoll/auth.env scripts/auth-server.mjs
node --env-file=/etc/lidoll/tracker.env scripts/serve.mjs
```

Run auth administrator commands with the **same auth environment file**. Initialization writes `clients.json` only if it does not exist. Changing `TRACKER_REDIRECT_URI` later does not overwrite existing clients; update the callback in that file and restart auth.

On the reverse-proxy server, configure DNS and HTTPS for `auth.sadgirlsclub.wtf`, then include [nginx-auth.conf](deploy/nginx-auth.conf) inside that HTTPS server block. Keep the tracker proxy inside the existing `lidoll.dev` HTTPS block. The snippets preserve the configured service address `10.1.1.23`, using ports 4173 and 4180. Only the reverse proxy should reach those service ports. `AUTH_TRUST_PROXY=1` trusts the proxy's scheme/IP headers, so the proxy must replace `X-Real-IP` and the service must not be directly reachable by clients.

If the auth HTTPS server block does not exist yet, use the complete [auth server configuration](deploy/nginx-auth-server.conf) and follow [AUTH_PROXY_SETUP.md](AUTH_PROXY_SETUP.md) for certificate issuance, installation, and renewal.

Production startup requires explicit HTTPS issuer/app URLs. Auth metadata is available at `https://auth.sadgirlsclub.wtf/.well-known/openid-configuration`. The combination of issuer and subject identifies an account. Follow the explicit issuer migration section below when moving an existing installation.

## Combined account and wallet consent

LiDollBot can request `openid profile wallet:read wallet:write stars:read stars:write`
through its existing `lidollbot` PKCE client. With no explicit client `scope`
field, the provider enables those scopes for `lidollbot`; other clients default
to `openid profile`. An explicit `scope` field overrides the default. Consent
shows coin/star reading and spending permissions, **Connect account and wallet**,
and **Cancel**. Profile-only tokens cannot authorize wallet access.

The tracker verifies a consented access token against `GET /wallet/identity`
using Bearer authentication. This returns verified issuer, subject, username,
client ID, wallet scopes and expiry. It requires a live token, grant and enabled
account; cookies and ID tokens do not authorize it. Auth never opens the market
or scientific database. See [LIDOLLCOIN_API.md](LIDOLLCOIN_API.md) for deployment.

If the tracker cannot reach the public issuer through the router, configure
`LIDOLLCOIN_IDENTITY_URL=http://10.1.1.23:4180/wallet/identity` in tracker.env.
Allow that service host to reach auth through the existing private network policy.
Keep browser sign-in and the issuer on public HTTPS; changing the issuer to an
IP address would change account identity.

## Add another application

```sh
node --env-file=/etc/lidoll/auth.env scripts/auth-admin.mjs add-client my-next-app https://next.lidoll.dev/auth/callback
```

Restart the auth service after editing client configuration. Configure the new application with:

| Setting | Value |
| --- | --- |
| Issuer | `https://auth.sadgirlsclub.wtf` |
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

This release supports self-registration and administrator-provisioned username/password accounts. Password resets remain administrator-managed; email delivery/recovery, MFA/passkeys, and a web admin console are not implemented. Shared login sessions last up to seven days. Little Log sessions expire after one hour and can reauthenticate through shared login. Disabling an account or resetting its password removes auth-service sessions; existing application sessions expire on their own schedule (up to one hour for Little Log).

**Sign out & clear device** ends Little Log's session and clears its browser records; it does not sign out every other application or end the shared auth login. Global app-session revocation/back-channel logout is not implemented. Treat these lifetime and logout semantics as part of the contract when integrating future apps.


## Move the existing issuer to auth.sadgirlsclub.wtf

Production examples and new-install defaults use `https://auth.sadgirlsclub.wtf`.
The updater preserves existing environment files. The same `little-log` client
and exact callback `https://lidoll.dev/tracker/auth/callback` serve both
observations and the Growth Chart; no second chart OAuth client is needed.

If this is a hostname move of the **same identity database and stable subjects**,
back up the identity service and tracker, stop the tracker, and run the migration
as its service user with the existing tracker environment:

```sh
node --env-file=/etc/lidoll/tracker.env scripts/migrate-issuer.mjs https://auth.lidoll.dev https://auth.sadgirlsclub.wtf --same-accounts
```

This command writes a new SQLite recovery backup, changes only the issuer key
on existing participants, and expires app sessions/login attempts. IDs,
observations and charts remain intact. It refuses subject collisions and never
merges usernames. Do not run it if the new provider has different accounts or
subjects; that requires a separately verified account mapping.

Set `OIDC_ISSUER` in tracker.env and `AUTH_ISSUER` in auth.env to the same new
HTTPS origin. Retain the auth database, signing/cookie keys and client
registration. Publish DNS/TLS/proxy configuration per AUTH_PROXY_SETUP.md, then
restart the services and verify discovery, sign-in and access to an existing
file before allowing further use. A different issuer without migration is a
different identity, even when its username matches. Restoring the old hostname
also requires a coordinated issuer-key migration or the recovery backup.

See [Growth Chart integration](GROWTH_CHART_GUIDE.md) for linking, offline changes,
conflict resolution and chart exports.

The shared sign-in page shows a prominent, full-width **Register for LiD0llID**
button for every registered app. It opens registration inside the current OAuth
interaction, preserving the requesting client, callback, PKCE and requested
permissions. No extra client registration or external-app update is needed.
Deploy the auth view and restart `lidoll-auth` to publish the button.


## Game sign-in

The PWA Games page opens MommyBot, which performs its own LiD0llID sign-in through the existing `lidollbot` client and registered callback. It resolves the verified issuer/subject to an already linked Discord account. PWA cookies and tokens are never forwarded. Game sessions and logout are separate from Little Log; see [GAMES_GUIDE.md](GAMES_GUIDE.md).
