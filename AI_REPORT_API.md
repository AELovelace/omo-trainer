# MommyBot report API

This read-only API lets MommyBot poll for completed nightly and explicitly shared Little Log AI reports and
retrieve their full Markdown documents. It does not post to Discord itself.
MommyBot's report publisher consumes this feed using its configured destination
channel. The admin console remains the place to edit prompts, run analysis,
inspect source statistics and manage access.

## Create a connection

1. Deploy the updated tracker, then open **Admin console → AI analysis →
   MommyBot report access**.
2. Enter a connection name and press **Create report-read token**. Copy the
   token into MommyBot's protected service configuration. It is displayed once;
   the tracker stores only its SHA-256 digest. There are at most ten active
   report tokens. If creation succeeds but the response is lost, revoke that
   token by its name and create another.
3. Configure the consumer with the tracker feed URL and token. For the default
   path, the URL is `https://<tracker-host>/tracker/api/ai-reports/v1/reports`.
   The console displays the complete URL for the installation's actual path.

Use `Authorization: Bearer <report-token>` on every request. Cookies, wallet
bearer tokens, query-string tokens and ordinary participant logins do not grant
report access. These credentials have the fixed `reports:read` capability;
they cannot run jobs, change settings, read raw records, retrieve prompt/source
snapshots or use wallet operations. A completed report's prose can of course
describe the aggregate statistics supplied to the model.

Tokens allow access to **completed nightly reports and manual reports explicitly
queued with Run and share with MommyBot**, including earlier shared reports.
Ordinary **Run now** reports remain private, even for the same report date or
when started at midnight. Direct retrieval of a private manual report ID returns
404. Existing report tokens work without replacement.
They do not expire automatically. Revoke or rotate them from the admin console.
Revocation takes effect on the next request. The issuing account must also
remain an enabled administrator: every read rechecks that account's live role.
Use HTTPS outside a trusted local development environment. Keep tokens out of
Discord messages and logs.

## Run and share an on-demand report

Save the desired prompt/settings in the admin console, choose a report date,
then press **Run and share with MommyBot**. The sharing choice is saved with the
job. It enters the existing polling feed only after successful completion;
failed or cancelled attempts stay out. Retry retains the original sharing
choice and report ID. Each completed job has one stable feed entry.

The administrator API accepts `shareWithBot: true` on the existing
`POST /tracker/api/admin/ai-analysis/run` request alongside `requestId` and `day`.
This still requires an enabled admin session and CSRF token; a report-read token
cannot queue analysis. Omitted or false means private. Reusing a request ID with
a changed date or sharing choice returns 409. Sharing cannot be enabled through
a feed query parameter, and existing private reports are not shared on upgrade.

MommyBot uses the same URL, token, channel and polling interval. Deploy the
updated bot client as well: it accepts `source: manual` only when
`share_with_bot: 1`. It captions these attachments as **Little Log requested
report**; nightly report captions and existing delivery receipts remain stable.

## List completed shared reports

```http
GET /tracker/api/ai-reports/v1/reports?after=0&limit=20
Authorization: Bearer <report-token>
```

`after` is a nonnegative integer cursor (default `0`). `limit` is `1`–`100`
(default `20`). The response is JSON:

```json
{
  "reports": [
    {
      "cursor": 1,
      "id": "report-uuid",
      "day": "2026-09-14",
      "source": "daily",
      "share_with_bot": 0,
      "scheduled_for": "2026-09-15",
      "created": 1789455600000,
      "finished": 1789455660000,
      "model_used": "model-name",
      "finish_reason": "stop"
    }
  ],
  "next_cursor": 1,
  "latest_cursor": 1,
  "has_more": false
}
```

Times are Unix milliseconds. `day` is the report's ending date; `source` is
`daily` or `manual`. Exported manual reports always have `share_with_bot: 1` and
`scheduled_for: null`; private manual reports are never returned. For nightly
reports, `scheduled_for` is the Los Angeles calendar date of the midnight that
scheduled it (normally the day after `day`). One unique job is scheduled per
midnight, with PST/PDT handled by `America/Los_Angeles`. The job may finish later
or be queued after a restart catches up the latest missed midnight; eligibility
comes from the saved schedule identity, not an exact creation/finish timestamp.
A cursor is assigned when a report **completes**, atomically
with its saved document. An older queued job that finishes late will therefore
appear in a later poll. Failed, queued and cancelled jobs are not exported.
Older completed nightly reports remain available after migration. Cursor values are
stable and may have gaps. Reading a report never consumes it.

List responses contain metadata only. Fetch each document separately to avoid
loading many long reports into one response. `next_cursor` is the last returned
cursor, or the supplied `after` value when the page is empty. `latest_cursor`
is the current end of the shared feed; private manual reports do not advance it. It is useful for choosing to skip historical
reports at first setup. **Do not use `latest_cursor` to advance normal polling**,
because there may be unread pages or newly completed reports.

## Retrieve a document

```http
GET /tracker/api/ai-reports/v1/reports/<report-id>
Authorization: Bearer <report-token>
```

The JSON response contains the same metadata plus:

```json
{
  "format": "markdown",
  "document": "# Daily report\n\nFull generated report text…",
  "incomplete": false
}
```

`incomplete` is true when `finish_reason` is `length`, meaning generation hit
the output limit. Documents can be long: report generation now accepts up to
50,000 output tokens. Use the full document as a Markdown attachment when
posting to Discord; a short message can identify the date, report ID and whether
the report may be incomplete. Treat the report as model-authored text and
disable mentions when the bot posts it.

## Consumer flow

- Store a durable cursor and a delivery record keyed by **destination channel
  and report ID** in MommyBot's database. On initial setup, explicitly choose
  historical delivery (`after=0`) or initialize to `latest_cursor` to send only
  future completions.
- Poll periodically, for example once per minute. Read ascending pages until
  `has_more` is false. The server exports completed nightly reports and explicit
  administrator sharing requests. Do not filter solely on `source: daily`;
  also accept `source: manual` with `share_with_bot: 1`. Track report IDs so each
  document is posted once to the configured destination after generation finishes.
  Ordinary manual analysis never adds a bot publication.
- Retrieve each selected document and save a pending delivery before sending.
  Save the returned Discord message ID and completion state after success,
  then advance the cursor. Retrying a GET is safe and does not mark a report
  delivered. Multiple independent consumers can read the same feed.
- If a Discord send has an uncertain result, reconcile that pending delivery
  before sending again. A polling cursor alone cannot guarantee exactly-once
  Discord delivery across a crash between sending and recording success.
- On `401` or `403`, stop publication and surface a configuration/access error.
  Retry transient network/server errors without advancing the cursor.

For a read-only connection check from a Node 24 process configured with
`MOMMYBOT_REPORTS_URL` (the full feed URL) and `MOMMYBOT_REPORTS_TOKEN`:

```js
const response = await fetch(process.env.MOMMYBOT_REPORTS_URL + '?after=0&limit=1', {
  headers: { Authorization: `Bearer ${process.env.MOMMYBOT_REPORTS_TOKEN}` },
  signal: AbortSignal.timeout(15000),
  redirect: 'error',
});
if (!response.ok) throw new Error(`Report API returned HTTP ${response.status}`);
const page = await response.json();
console.log({ count: page.reports.length, latestCursor: page.latest_cursor });
```

These variables match MommyBot's report consumer configuration. Deploy both
tracker and bot updates; configuring or starting a live publisher is separate
from this read-only connection check.

## Errors, administration and storage

- `400`: invalid cursor, limit or report ID.
- `401`: missing, invalid or revoked report token.
- `403`: issuing administrator lost access, or a disallowed browser origin.
- `404`: unknown endpoint/report, a private manual report, or a shared report that has not completed.
- `405`: mutations are not supported; external report routes accept only GET.
- `500`: transient server error; retry without advancing delivery state.

All responses use `Cache-Control: no-store`. The external API grants no
cross-origin browser access. Admin token-management endpoints are
`GET/POST /api/admin/ai-analysis/tokens` and
`POST /api/admin/ai-analysis/tokens/revoke` with `{ "id": "token-uuid" }`,
under the installation's base path. They require an administrator session and
the existing CSRF protection for writes. Token creation and revocation are
audited without storing secrets in the audit trail.

`ai_report_tokens` and `ai_report_feed` are private science-database tables;
existing SQLite backups include them. `tests/ai-report-api.test.mjs` covers
output limits, migration, completion ordering, token isolation and HTTP access
controls. The browser test covers generating, hiding and revoking a token and
clearing it when administrator access ends.
