# Login bonuses and diamonds

The first **new observation, wetting, or diaper change successfully synced** each account day earns one daily check-in bonus. Opening the app, random rolls, corrections, deletion/restoration, and replayed uploads do not qualify. Every wetting category qualifies, including Bedwetting and Used the potty. A dry diaper change qualifies too.

| Consecutive day | Bonus |
| --- | --- |
| 1 | 10 coins |
| 2 | 20 coins |
| 3 | 30 coins |
| 4 | 1 diamond |
| 5 | 2 diamonds |
| 6 and onward | One additional diamond each day |

A missed calendar day resets the next check-in to day 1. Existing currency balances remain. The timezone is pinned from the account's earliest enrollment when its first bonus is earned (UTC if there is no enrollment). It does not change with travel or later enrollment edits. Server receipt time determines the reward date: offline records count when synced, and backdating a record cannot fill missed days. Historic records are not automatically paid retroactive login bonuses.

The **Login bonuses** menu tab offers weekly and monthly calendars, previous/next navigation, a month selector, current/best streaks, total check-in days, and the next payout. Select a date to see observations, event classifications, intake, diaper changes and their wetting totals, and rolls. Statistics follow the recorded event's date in the bonus timezone and reflect edits/deletions; bonus receipts remain permanent. A sync-day reward may therefore appear on a different date from a backdated event's statistics. Pending rewards are labeled when the market is unavailable.

**Stickers & market** shows diamonds and exchanges any positive whole number at **1 diamond = 50 coins**. Conversion is one-way. The same pending-exchange recovery used by sticker trades protects lost-response retries. Both balances, ledger entries and the receipt commit atomically; insufficient diamonds or coin overflow leave balances unchanged.

## Storage and API

`server/login-bonuses.mjs` owns account timezone and daily receipts in the scientific database. Sync inserts attendance and its outbox entitlement in the same transaction as the qualifying new record. `server/reward-bridge.mjs` sends only a hashed entitlement ID, currency and amount to the market. Market schema **9** adds a separate integer diamond balance and idempotent daily payout receipts. Back up both scientific and market databases together; older market-schema-8 code cannot open schema 9.

`GET /tracker/api/login-bonuses?from=YYYY-MM-DD&to=YYYY-MM-DD` is session-authenticated, private and `no-store`. The optional inclusive window is limited to 42 days; by default it returns the current bonus month. Responses include `participant`, `today`, `timeZone`, `streak`, `longestStreak`, `totalDays`, `checkedInToday`, `nextReward`, `earned`, and `days`. Each day has a nullable check-in receipt (`streak`, `asset`, `amount`, `paid`) and daily statistics. External wallet credentials cannot read this endpoint. There is no user-controlled claim endpoint.

`GET /tracker/api/record-reward?id=RECORD_ID` also includes `dailyBonus` for the exact record that qualified that day, allowing the existing save modal to announce the award.

Diamond conversion uses the existing session/Origin/CSRF-protected economy endpoint:

```json
{"requestId":"unique-stable-id","action":"diamond-exchange","quantity":2}
```

External wallet support, explicit diamond permissions and MommyBot integration are documented in [LIDOLLCOIN_API.md](LIDOLLCOIN_API.md).

## Verification

Run `npm test`. Focused tests are `tests/login-bonuses.test.mjs` and `tests/diamond-api.test.mjs`; they cover streak growth/reset, account days and DST, immutable receipts, edits/retries, restart/outbox replay, private balances, scoped access, earning caps and atomic conversion failures. With `PUPPETEER_MODULE` and `CHROME_PATH` configured, run `node tests/login-bonuses-browser.mjs` for weekly/monthly navigation, actual save rewards, daily stats, mobile themes, diamond exchange, session/CSRF protection and offline recovery.

With the MommyBot checkout beside this project (or MOMMYBOT_ROOT set), run `node tests/mommybot-diamonds-integration.mjs` to exercise its real WalletClient against an isolated tracker HTTP API: consent, balances, credit/retry, debit/refund and revocation. It sends no Discord messages and touches no live wallets.
