# Administrator statistics API and CrowPanel

The statistics API is **admin-only**, including individual drilldown. A device uses a dedicated, read-only bearer token belonging to an enabled administrator. Ordinary participant sessions, wallet grants and AI report tokens cannot read it. Demotion, account disabling or token revocation takes effect on the next request.

After deploying this tracker version, open **Admin console → Statistics devices**. Name the panel, select **Everyone and individual views (admin)**, and create a token. Copy it once into the sketch's private `config.h`. The optional **My statistics only** scope further restricts an administrator's device to that administrator's own records; it does not allow participant accounts to use the API.

The configured LAN base is `http://10.1.1.23:4173/tracker/api/statistics/v1/`. Use the actual reachable tracker address if the LAN setup changes. This is the tracker server, not the llama.cpp endpoint. Requests send:

```http
Authorization: Bearer llstats_REPLACE_WITH_ADMIN_DEVICE_TOKEN
Accept: application/json
```

Tokens in query strings and cookie-only requests do not authenticate. HTTP is for a trusted LAN; use HTTPS with a trusted root CA for other networks. The sketch never follows redirects or disables certificate validation.

## Read endpoints

| GET path, relative to the base | Result |
| --- | --- |
| `summary?scope=all&days=7` | Everyone's combined totals and one row per saved calendar day |
| `participants?limit=50&offset=0` | Participant IDs and labels for the drilldown selector |
| `summary?scope=participant&participantId=UUID&days=7` | One selected participant's totals and daily rows |
| `summary?scope=self&days=1` | The issuing administrator's own statistics |

`summary` defaults to `scope=self`, `days=7` and an end date of today in `America/Los_Angeles`. `days` accepts integers 1–31. Optional `to=YYYY-MM-DD` selects a historical end date, from 2000-01-01 up to today in LA. `participantId` is valid only with `scope=participant`. Date windows include both ends.

Responses have `schemaVersion: 1`, `capturedAt` (UTC), `timeZone`, `today`, `from`, `to`, `scope`, `participant` (null for everyone), `registeredParticipants`, `totals`, `days`, `dateBasis` and `limitations`. Totals include:

| Field | Meaning |
| --- | --- |
| `observations` | Saved liquid observations, including legacy snapshots |
| `liquidsMl` | Intake, preserving interval/cumulative semantics for each participant-day |
| `wettings` | Wetting records across all categories, **including used-the-potty** |
| `diaperChanges` | Saved diaper-change records |
| `chartStars` | Checked growth-chart cells on the selected dates |
| `randomRolls`, `randomPeeResults` | Game draws, kept separate from recorded wettings |
| `categories` | Counts keyed by the tracker's seven wetting category identifiers, including `bedwetting` and `used-the-potty` |

Every `days` row also contains `date` and `activeParticipants` (participants with tracking records that day). Active participant counts are not summed into a distinct-user total. `registeredParticipants` is the cohort size, including disabled accounts, or 1 for an individual.

Records use **their saved local date**, matching the existing admin analytics; the default end date uses LA time and respects DST. Deleted records are excluded. Late syncs and edits affect future reads. A zero means no matching saved data, not necessarily no real-world events. These endpoints do not export raw records, free text, wallet balances, login bonuses or AI documents.

The participant directory returns `{scope, participants: [{id,label}], total, nextOffset}` ordered by stable ID. `limit` is 1–100, default 50. `offset` defaults to 0; `nextOffset: null` ends pagination. A self-scoped admin token sees only its owner. The sketch pages one identity at a time, so it does not silently truncate larger participant lists.

All responses are JSON with `Cache-Control: no-store` and an explicit byte `Content-Length` for bounded device reads. Errors use `{error}`: 400 invalid range, 401 missing/invalid/revoked token, 403 insufficient or lost admin access, 404 missing route/participant, 405 write attempt. API reads never consume or modify tracking records or rewards.

## Token management

The console uses these session-authenticated routes (relative to `/tracker/api/`):

- `GET admin/statistics/tokens`: issuing admin's token metadata, never the secret.
- `POST admin/statistics/tokens`: `{name, scope: "all" | "self"}`; returns the new `token` once, with ID and metadata.
- `POST admin/statistics/tokens/revoke`: `{id}`; revokes an owned token idempotently.

POSTs require the normal same-origin admin session and `X-CSRF-Token`. Names allow 80 characters; each administrator may have up to ten active tokens. Creation/revocation is audited without secrets. SQLite stores only SHA-256 token digests in `statistics_tokens`; normal tracker backups include the grants. Deployment creates that table and a date index automatically. No existing wallet or report consent is expanded.

## CrowPanel companion

The sketch lives at `F:\Langley\Documents\Arduino\lidoll-logger\lidoll-logger.ino`; its adjacent `README.md` contains board setup, dependency versions, configuration and build commands. It targets the **Elecrow CrowPanel Advance 7-inch ESP32-S3 V1.4**, with an everyone overview, individual drilldown using Previous/Next, and Today / 7 days / 31 days windows.

Screen rendering and touch run separately from a FreeRTOS network worker. It polls every 60 seconds, supports manual Sync, labels retained values as stale on connection failures, and clears private values after HTTP 401/403. Switching selection clears old values and rejects delayed responses for the previous selection. No API writes or automatic Discord messages originate from the panel.

Validation: `npm test`, `node tests/statistics-browser.mjs`, and the sketch's `ps/build.ps1`. Physical RGB output, touch orientation, reconnect behavior and power stability still require a real panel test.
