# LiDollCoin API v1

LiDollQuest can link a Little Log account and use its existing **online LiDollCoin balance** and separate **stars balance**. The game sends individual earnings and costs. It never uploads or replaces the online balance with a value from a save file. Unlinked games keep local gold; linking does not deposit that gold, and disconnecting restores the separate local balance.

The initial release accepts earnings reported by a linked game, as requested. It does not verify game progress, prevent edited-save reward farming, or provide a real-money payment system. Configurable earning limits, scoped grants, whole-number balances, atomic ledger writes and replay protection are active now.

## Deploy

Deploy the updated Little Log server and public assets together, then rebuild LiDollQuest. The default native client is **lidollquest** and the game's API constant is **https://lidoll.dev/tracker/api/lidollcoin/v1/** in scrLiDollCoin.gml. Change that constant if Little Log is hosted elsewhere.

Market schema version 6 adds OIDC exchange receipts alongside existing connection and game-operation tables in **market.sqlite**. Back up that file before deploying; old servers refuse this newer market version. Scientific records remain in little-log.sqlite. No live deployment is performed by these changes.

Register other apps or browser origins using the server environment variable **LIDOLLCOIN_APPS**, a JSON array, for example:

~~~json
[{"id":"lidollquest","name":"LiDollQuest","origins":["https://your-game.example"],"dailyLimit":1000000}]
~~~

Native apps need no browser origin or shared app secret. Browser apps must use an exact registered HTTPS origin (the Little Log origin itself is also accepted). Null/wildcard origins are rejected. Omit the variable for the native LiDollQuest default. The earning limit is per app, account and UTC day, across all tokens; changing tokens does not reset it. Existing receipts remain valid if retried after a limit or configuration change.

All external routes require **?client_id=lidollquest**. Requests and responses are JSON; device/token requests also accept application/x-www-form-urlencoded. Responses use Cache-Control: no-store. External routes use Bearer authentication, never the Little Log session cookie. User approval uses a separate same-origin session and CSRF-protected UI at **/tracker/coins/**.

## Connect an account

Server applications already using LiD0llID can use the combined flow below.
The device flow remains available for existing native clients.

1. POST **device?client_id=lidollquest** with the requested scopes:

~~~json
{"scope":"wallet:read wallet:write"}
~~~

The response includes **device_code**, **user_code**, **verification_uri**, **expires_in: 600** and **interval: 5**. Keep device_code private. Show user_code in the game and open verification_uri in the player's browser. The player signs in with LiD0llID, enters the code, reviews the registered app and permissions, and allows or denies the connection. Do not auto-approve codes.

2. Poll POST **token?client_id=lidollquest** no more often than the returned interval:

~~~json
{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"DEVICE_SECRET"}
~~~

While waiting, HTTP 400 returns error **authorization_pending**. For **slow_down**, increase the polling interval by 5 seconds for all subsequent polls. Stop on **access_denied** or **expired_token**. The successful response contains **access_token**, **token_type: Bearer**, **expires_in: 2592000**, and **scope**. A device code issues a token once; if that response is lost, reconnect. Tokens expire in 30 days and can be revoked sooner.

The device-code interaction follows the structure of [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628); these application endpoints are not the LiD0llID identity-provider token endpoint. Tokens are stored hashed on the server. Native clients should protect their local token file; never include it in game-save exports or source control.

## Combined LiD0llID account and wallet login

MommyBot uses one LiD0llID approval for identity and both currencies. Deploy the
updated **auth and tracker services before MommyBot**. Stop older tracker workers
before opening market schema 6 and use the normal stopped-service backup procedure.
Existing scientific records and balances are preserved.

Keep the existing `lidollbot` identity registration and exact callback
`https://bot.lidoll.dev/auth/callback`, using PKCE S256 and no client secret.
Also register `lidollbot` in `LIDOLLCOIN_APPS`, preserving other app entries.
Both registrations must exist; identity registration does not register a wallet app.

Request `openid profile wallet:read wallet:write stars:read stars:write` and
`prompt=consent` during authorization. The provider displays all four wallet
permissions alongside account linking. After verifying the normal OIDC callback,
keep its access token server-side. Exchange it when the initiating Discord user
submits the existing confirmation code:

~~~http
POST /tracker/api/lidollcoin/v1/exchange?client_id=lidollbot
Content-Type: application/json
~~~

~~~json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "subject_token": "SHORT_LIVED_OIDC_ACCESS_TOKEN"
}
~~~

This is an application-specific exchange endpoint, not a general OAuth token
exchange implementation. It accepts only the configured identity service's
access tokens for the requested client, carrying explicit wallet scopes. An ID
token, submitted username/subject, or browser session cannot authorize it.

~~~json
{
  "access_token": "WALLET_BEARER_TOKEN",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "wallet:read wallet:write stars:read stars:write",
  "account_id": "APP_SCOPED_OPAQUE_ACCOUNT_ID",
  "identity": {"issuer": "https://auth.lidoll.dev", "subject": "VERIFIED_SUBJECT"}
}
~~~

Match the returned identity to the verified OIDC identity before activating it.
The issuer above is an example; preserve the deployment's actual issuer. The
wallet token lasts up to 30 days and uses the existing wallet, operations and
revoke routes. Chart stars remain intact; the separate stars balance is spent.
No scientific records are returned. The market keeps proof/token hashes and an
exchange seed, never the raw OIDC or wallet token. Retrying the same valid proof
returns the same grant with its remaining lifetime. A revoked grant cannot be
revived by replaying that proof. An expired proof requires a fresh login.

For Doll's LAN, add this to `/etc/lidoll/tracker.env`:

~~~dotenv
LIDOLLCOIN_IDENTITY_URL=http://10.1.1.23:4180/wallet/identity
~~~

Restart `lidoll-auth` and `lidoll-tracker` after deploying the updated code.
Without this setting the tracker uses `OIDC_ISSUER` plus `/wallet/identity`.
Private/loopback HTTP is supported for this explicit back channel; public
addresses require HTTPS. Redirects are rejected and the verified issuer must
still match `OIDC_ISSUER`. This transport setting never changes account keys.
MommyBot can retain its private API URL on port 4173; its two client IDs must
both be `lidollbot`. See MommyBot's ONLINE_WALLET_GUIDE.md for bot deployment.

Run `npm test` for server checks. The optional full integration check is
`node tests/combined-login-browser.mjs`, with `MOMMYBOT_ROOT` pointing to its
checkout, `PUPPETEER_MODULE` to an installed Puppeteer ES module (file URL), and
`CHROME_PATH` to Chrome/Chromium. Local Windows defaults are provided. It starts
disposable services, exercises real PKCE/consent and the Discord confirmation
handler, simulates a lost exchange response, verifies star access, and cancels
another consent. It saves a consent screenshot under ignored `artifacts/` and
never accesses live accounts.

## Read the balance

GET **wallet?client_id=lidollquest** with **Authorization: Bearer ACCESS_TOKEN** requires wallet:read:

~~~json
{"currency":"LiDollCoin","balance":150,"account_id":"APP_SCOPED_OPAQUE_ACCOUNT_ID"}
~~~

Balance is an integer from 0 to 2,147,483,647. account_id identifies the linked player within this app; bind pending operations to it and do not replay them after linking a different account. The response does not include names, scientific records or sticker data. With `stars:read`, it also includes `stars` (integer balance) and `stars_enabled` (whether this grant also has `stars:write`).

## Earn and spend

POST **operations?client_id=lidollquest** with Bearer authentication requires wallet:write:

~~~json
{"request_id":"stable-game-event-id","kind":"credit","amount":20}
~~~

Use **credit** for rewards and item sales; use **debit** for costs and purchases. Amount must be a positive integer. The API applies a relative change to the current server balance atomically. It rejects overdrafts and overflow. Credit issuance is capped by the app's dailyLimit; debits and refunds do not reset that limit. Game earnings and spending appear in the account's existing wallet ledger with the app ID.

~~~json
{"operation_id":"server-operation-uuid","request_id":"stable-game-event-id","kind":"credit","amount":20,"balance":170,"currency":"LiDollCoin"}
~~~

Persist the exact request and request_id **before sending**. IDs allow letters, digits, underscore and hyphen, up to 80 characters. The same app/account/request_id with the same operation returns the original receipt without another balance adjustment. Reusing that ID with a different operation returns 409. A new token for the same app/account can retry it. A receipt's balance is a historical result: GET wallet after completing a queue to refresh changes from other apps.

Never deliver a purchased item on a timeout or an unconfirmed debit. Retry the same debit. If delivery becomes impossible, refund the confirmed debit:

~~~json
{"request_id":"stable-refund-id","kind":"refund","original_id":"original-debit-request-id"}
~~~

A refund returns exactly the original debit amount, to the same account and within the same app. The original debit may be refunded only once. Refund requests also have replay-safe receipts. The client cannot choose a refund amount or recipient.

## Disconnect

POST **revoke?client_id=lidollquest** with the token and an empty JSON object revokes that connection. Players can also use **Settings > Manage connected games** in Little Log. Revocation and disabled accounts take effect on subsequent API requests, without changing balances. An expired/revoked token must be reconnected; no refresh tokens are issued in v1.

## Errors

Errors return **error** and **error_description**. Common HTTP statuses: 400 invalid input/device state; 401 invalid token/client; 403 missing scope or disallowed origin; 409 insufficient funds, conflicting receipt or already-refunded debit; 429 rate/earning limit; 503 wallet unavailable. Retry network/5xx failures with the same request_id. A daily_limit error can retry after the next UTC day. Do not repeatedly retry definitive invalid-input errors.

## Game behavior

In the browser game, choose **Link account** on the title screen; LiD0llID sign-in returns automatically to the game after first-time approval. Native builds retain the code-based Link LiDollCoins control or **L**. The inventory and shop display LiDollCoins while linked. Rewards, dialogue/narrative gold, quests, room events, trap rewards and shop sales use the online operation queue. Purchases wait for server confirmation before delivering the item; an interrupted purchase without its original in-memory item context refunds instead of guessing a delivery.

Native builds keep the connection and pending operation journal in **lidollcoin_wallet.json** in GameMaker's app storage, with a .bak recovery copy. That native file contains a credential; do not share it. Browser builds use a credential-free localStorage journal and a separate HttpOnly session cookie. No account token is written into save slots. Do not delete the journal while operations are pending. Save/load, switching connections and returning to title wait for pending wallet changes to settle. Cached balances are informational while disconnected; linked purchases require an available wallet.

This does not make game-world saves and the online database one atomic transaction. Loading older game saves can replay gameplay rewards, and a crash after an item is delivered but before a world save can lose that local item. The wallet itself never accepts the saved absolute gold balance. Stronger game-state verification remains a future feature.

## Verification

Run **npm test** for device consent/expiry/backoff, scopes, CSRF/CORS, revocation, account isolation, persistence, integer validation, overdrafts, receipts and refunds. Run **node tests/coin-browser.mjs** with PUPPETEER_MODULE and CHROME_PATH configured for the browser approval workflow, wallet operations and revocation against disposable local accounts.

## First-party browser game sessions

LiDollQuest at `/game/` uses same-tab LiD0llID sign-in through `/tracker/api/lidollcoin/browser/connect`. The existing OIDC callback accepts the allowlisted `returnTo=game-wallet` destination and returns to the consent page. Approval sets a separate thirty-day HttpOnly, Secure, SameSite=Lax cookie scoped to `/tracker/api/lidollcoin/browser/`, then redirects only to `/game/`. Cancel returns to `/game/?wallet=cancelled`. No token is included in a redirect or returned to browser JavaScript. Reusing approved access rotates this browser's session while retaining other devices' sessions.

- GET `session` returns `{linked:false}` when signed out, otherwise `{linked:true,currency,balance,account_id,csrf}`. It never creates a link from a Little Log cookie alone.
- POST `operations` uses the same relative operation and receipt contract as the bearer API. Require the wallet cookie, matching `Origin`, and `X-CSRF-Token` from GET session.
- POST `revoke` uses the same protections, revokes this browser grant, and clears its cookie.
- GET/POST `connect` use the separate Little Log session for first-time permission. Consent POST requires its form CSRF token and the same origin. Existing approved access submits the same protected form automatically using public `coins/browser.js`.

These routes expose no scientific data and do not enable credentialed cross-origin access. Public external-app bearer routes remain unchanged. Pending game receipts remain keyed by app, account and request ID across browser session rotation. Market schema 4 adds browser-grant and remembered-permission tables; no scientific payload is copied into them. A revoked browser grant also removes remembered wallet approval so a future reconnect asks again.

Deploy the backend and `coins/browser.js` before deploying the matching game. Static tracker hosting must copy that script alongside the existing coin assets; API and OIDC callback paths already use the Node proxy. Rebuild the whole game package, including its LiDollBrowser JavaScript extension. The browser game's connection flow is tested with the actual GX runtime and a real local OIDC provider by the game repository's `ps/Test-CoinWalletBrowser.ps1`.

Embedded LiDollQuest sends `view=embedded` to browser/connect and navigates the full browser tab. Its OIDC return destination is allowlisted as `game-wallet-embedded`; consent preserves the view in a hidden field. Approval returns to the fixed website root `/`, and cancellation to `/?wallet=cancelled`. Other view values use the standalone `/game/` return. Authentication pages retain their frame-ancestors protection. Update both server files and rebuild the game extension for this flow.

## Stars in connected games

The same wallet and operations routes now support stars. Stars live in the separate market database; earning or spending through the game never adds or removes potty-chart cells. Existing chart rewards continue to add to this same stars balance.

Native clients request `wallet:read wallet:write stars:read stars:write` when linking. The two star permissions are independent: `stars:read` exposes stars in GET wallet, and `stars:write` authorizes star operations. A stars-only read grant receives account_id/stars/stars_enabled without the coin balance. Existing coin grants retain their original permissions. Browser consent now explicitly covers both currencies; remembered coin-only approval requires one new approval before stars are enabled. LiDollQuest shows **Enable stars** on its title-screen account button for an older connection.

Send `asset: "stars"` on every star credit, debit **and refund**:

```json
{"request_id":"quest-star-reward-unique-id","asset":"stars","kind":"credit","amount":5}
```

```json
{"request_id":"star-purchase-unique-id","asset":"stars","kind":"debit","amount":2}
```

```json
{"request_id":"star-refund-unique-id","asset":"stars","kind":"refund","original_id":"star-purchase-unique-id"}
```

Receipts include `currency: "Stars"`, `asset: "stars"`, and `balance` for stars only. Coin receipts continue to use `currency: "LiDollCoin"`; omitting asset still means coins. New coin receipts also include `asset: "coins"`. Replayed older receipts retain their original shape. IDs are unique across both currencies for each app/account; changing currency under an existing ID returns 409. A refund must use the original debit's currency. Amounts and balances are bounded whole numbers; overdrafts and overflow fail atomically. The game only updates its coin cache from coin receipts.

App registration supports optional `starDailyLimit` (1?2,147,483,647), defaulting to that app's `dailyLimit`. Star and coin issuance caps are counted independently per app/account/UTC day. New grants, spending and refunds do not reset either cap. No new configuration is required for existing deployments.

Deploy the new Little Log backend **before** the game. Stop old backend workers before upgrading: market schema 5 adds currency to existing operation rows and records star approval separately. Back up both databases; the science schema is unchanged. Older coin clients remain supported, including pending receipts. Do not run an old backend worker against this upgraded market database. Existing linked players use **Enable stars** once after deployment.

Game helpers and asynchronous receipt handling are documented in the game repository's STAR_WALLET_GUIDE.md. No quests or shops award/spend stars automatically until their scripts call these helpers.


## Diamonds (market schema 9)

Diamonds are a separate whole-number balance. One diamond exchanges for 50 LiDollCoins on the tracker Stickers page; the external operations API does not silently convert currencies.

Request explicit `diamonds:read diamonds:write` in the device or combined OIDC consent flow. MommyBot now requests `openid profile wallet:read wallet:write stars:read stars:write diamonds:read diamonds:write`. If the identity client's configured `scope` is allowlisted, add both diamond scopes there too. Existing tokens and remembered game-browser grants do not automatically gain new permissions.

With `diamonds:read`, the wallet response adds `diamonds` (integer), `diamonds_enabled` (whether write permission is present), and `diamond_coin_value: 50`. Without read consent these fields are omitted. Existing coin/star response fields remain compatible.

Use the existing operations endpoint with `asset: "diamonds"` and `kind: "credit"`, `"debit"` or `"refund"`. Credit/debit require a positive integer `amount`; refund requires `original_id`. Responses retain the existing receipt fields with `asset: "diamonds"`, `currency: "Diamonds"`, and a diamond `balance`. Retries must reuse the original `request_id` and body. Refunds require a diamond debit belonging to the same account and app and may be paid once. Old coin/star receipt fingerprints remain unchanged.

Each LIDOLLCOIN_APPS registration may set `diamondDailyLimit`, a positive integer independent of coin/star limits. The default is `max(1, floor(dailyLimit / 50))`. Caps apply per account/app/UTC day to external credits; reconnecting does not reset them. Streak rewards use their own server policy and do not consume an external app's credit cap.

Deploy the identity service with diamond consent scopes, then the tracker with market schema 9, then MommyBot. Back up both tracker databases and the bot state first. Renew a bot connection through /lidollid login to approve diamonds. Existing grants retain coin/star access until renewed. MommyBot shows diamond balances and supports administrator diamond gifts via /lidollid wallet gift and its private menu. No new Discord message is sent merely by updating the code.

The authenticated daily calendar API and attendance policy are documented in [LOGIN_BONUSES_GUIDE.md](LOGIN_BONUSES_GUIDE.md). Wallet tokens never expose calendar or health statistics.
