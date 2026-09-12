# LiDollCoin API v1

LiDollQuest can link a Little Log account and use its existing **online LiDollCoin balance**. The game sends individual earnings and costs. It never uploads or replaces the online balance with a value from a save file. Unlinked games keep local gold; linking does not deposit that gold, and disconnecting restores the separate local balance.

The initial release accepts earnings reported by a linked game, as requested. It does not verify game progress, prevent edited-save reward farming, or provide a real-money payment system. Configurable earning limits, scoped grants, whole-number balances, atomic ledger writes and replay protection are active now.

## Deploy

Deploy the updated Little Log server and public assets together, then rebuild LiDollQuest. The default native client is **lidollquest** and the game's API constant is **https://lidoll.dev/tracker/api/lidollcoin/v1/** in scrLiDollCoin.gml. Change that constant if Little Log is hosted elsewhere.

Market schema version 3 adds connection and game-operation tables in **market.sqlite**. Back up that file before deploying; old servers refuse this newer market version. Scientific records remain in little-log.sqlite. No live deployment is performed by these changes.

Register other apps or browser origins using the server environment variable **LIDOLLCOIN_APPS**, a JSON array, for example:

~~~json
[{"id":"lidollquest","name":"LiDollQuest","origins":["https://your-game.example"],"dailyLimit":1000000}]
~~~

Native apps need no browser origin or shared app secret. Browser apps must use an exact registered HTTPS origin (the Little Log origin itself is also accepted). Null/wildcard origins are rejected. Omit the variable for the native LiDollQuest default. The earning limit is per app, account and UTC day, across all tokens; changing tokens does not reset it. Existing receipts remain valid if retried after a limit or configuration change.

All external routes require **?client_id=lidollquest**. Requests and responses are JSON; device/token requests also accept application/x-www-form-urlencoded. Responses use Cache-Control: no-store. External routes use Bearer authentication, never the Little Log session cookie. User approval uses a separate same-origin session and CSRF-protected UI at **/tracker/coins/**.

## Connect an account

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

## Read the balance

GET **wallet?client_id=lidollquest** with **Authorization: Bearer ACCESS_TOKEN** requires wallet:read:

~~~json
{"currency":"LiDollCoin","balance":150,"account_id":"APP_SCOPED_OPAQUE_ACCOUNT_ID"}
~~~

Balance is an integer from 0 to 2,147,483,647. account_id identifies the linked player within this app; bind pending operations to it and do not replay them after linking a different account. The response does not include names, scientific records, stars or sticker data.

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
