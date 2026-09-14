# Administrator AI analysis

Open **Admin console → AI analysis**. The panel, settings, queue actions and saved
reports require an enabled administrator session. Every API request rechecks that
role; changes also require the existing same-origin CSRF token. There is no
participant analysis API. Administrators can explicitly create a separate
read-only token for MommyBot to retrieve completed report documents through
[AI_REPORT_API.md](AI_REPORT_API.md). Reports are not published to the app.

Edit the analysis prompt, comparison window (1–31 days), model, maximum output
tokens and temperature, then **Save settings**. This customizes instructions for
inference; it does not train model weights. **Run now** queues a report ending on
the selected date, using those saved settings. The default date is yesterday in
Los Angeles. Selecting today produces a report of the data available so far.
The prompt and source statistics can be reviewed with every saved report.

The maximum output setting now allows **256–50,000 tokens** and defaults to
**50,000**. The upgrade raises the active saved limit to 50,000 once, preserving
the custom prompt and other settings. Later administrator choices are retained
across restarts. Jobs already queued keep their original setting; create a new
run to use the higher limit. The model still needs sufficient context and may
finish before this maximum. The independent two-hour inference deadline remains.

## Connection and deployment

The tracker server calls `http://192.168.1.188:9090` by default. The administrator's
browser never connects directly to that address. The implementation uses llama.cpp's
[OpenAI-compatible server endpoints](https://github.com/ggml-org/llama.cpp/tree/master/tools/server#api-endpoints):
`GET /v1/models` for an empty model setting, followed by `POST /v1/chat/completions`.
Requests use non-streaming chat completions. Only the returned report text is saved;
reasoning-only responses with no report content are reported as failed attempts.

Optional tracker service environment settings in `/etc/lidoll/tracker.env`:

```dotenv
AI_ANALYSIS_URL=http://192.168.1.188:9090
# AI_ANALYSIS_API_KEY=your-server-key-if-required
```

Use a base URL, optionally ending in `/v1`, rather than a chat-completions URL.
The endpoint is configured on the server, not through a browser-supplied URL.
Redirects are rejected. The model must have enough context for the prompt, the
aggregate statistics and the selected output limit. Reduce the day window or
output limit when the model rejects the context size; data is never silently
truncated to make it fit. HTTP errors, empty reports and connection failures are
visible in the report list without displaying upstream response bodies or keys.

Deploy the updated tracker code and restart `lidoll-tracker` using the normal
Fedora deployment flow. No separate worker service, proxy timeout increase,
cron entry or additional npm dependency is required. The tracker process starts
and supervises a worker thread with its own database connection. Existing service
network permissions allow outbound IPv4/IPv6; routing and endpoint firewall rules
must allow the tracker host to reach port 9090. A local connection probe can use:

```bash
curl --connect-timeout 5 --max-time 15 http://192.168.1.188:9090/v1/models
```

The configured LAN address timed out from the development machine during this
implementation. Automated tests use a synthetic local model server; verify the
connection from the deployed tracker host with **Run now**.

## Daily schedule and durability

- Daily reports are enabled by default and queued within five seconds of midnight
  in `America/Los_Angeles`, including PST/PDT changes. Each daily report ends on
  the previous calendar date. One unique scheduled job is saved per midnight.
- Installation starts at the next midnight. After downtime, the worker catches
  up the latest missed midnight only, rather than flooding the model with every
  missed date. Use the report date picker to request older reports manually.
- Pausing daily reports affects future scheduling. Existing queued work remains
  available; cancel it in the report list. Manual runs remain available while
  daily scheduling is paused.
- Queueing returns HTTP 202 immediately. Computation and inference continue after
  the browser closes. One leased job runs at a time; later work waits in SQLite.
  The schedule is still checked while inference is running. A busy worker starts
  the midnight report after its existing work completes.
- Each inference attempt has a two-hour deadline, independent of proxy and browser
  requests. Failed attempts wait five minutes and retry up to three attempts.
  A crashed worker's 90-second lease expires before another worker can resume it.
  Recovery may recompute an interrupted inference but cannot save two documents
  for the same job or overwrite a result with an expired worker's response.
- Cancel invalidates a queued or running job immediately. A running worker checks
  cancellation at most every 15 seconds and aborts its connection. Already-running
  model computation may take longer to stop on the inference server itself.
- **Retry** on failed/cancelled reports reuses the saved prompt and any source
  snapshot already captured. Use a new run to analyze newly synced records.
  Manual requests have retry IDs and a 20-job pending limit.

## Source data and saved documents

Reports cover all participants, including disabled accounts, independently of the
ordinary analytics filters. The worker aggregates current, non-deleted tracking
records and chart stars into daily counts: active participants, observations,
liquid intake, all seven wetting categories, diaper changes, chart stars, random
rolls and random Pee results. It sends no participant names, IDs, free-text notes,
passwords, tokens, wallet balances, login-bonus history or notification contents.

Dates follow each record's saved local date, matching existing admin analytics;
the schedule itself uses Los Angeles time. Intake is calculated separately for
each participant-day with the existing interval/cumulative snapshot rules. Legacy
SQL-only records are included. Random game results remain separate from actual
recorded events. Missing logs are not evidence that no real-world events occurred.
Late uploads and corrections can change statistics in a later newly requested
report. A consistent source snapshot is captured when a job first runs, using a
WAL read transaction so aggregation does not lock participant saves.

Settings, jobs, source snapshots and Markdown documents live in
`ai_analysis_settings` and `ai_analysis_jobs` inside the private
`little-log.sqlite` database. Existing science-database backups include them.
They persist across application releases and restarts, with no automatic deletion;
history pages expose 50 reports at a time. They are not included in participant
exports, admin record-transfer imports/exports, public assets or service-worker
caches. Review them through the admin API and **Download Markdown**.

Model text is rendered literally, including Markdown syntax, rather than executed
as HTML. Downloads include the report, model, completion reason, saved settings
and source statistics. Reports that reach the output token limit are marked as
potentially incomplete. The default prompt asks for descriptive findings and
uncertainty; administrators should review generated conclusions against the
saved statistics.

## Verification

`npm test` includes `tests/ai-analysis.test.mjs`: authorization and CSRF, scheduling
and DST, durable claims and recovery, prompt snapshots, intake semantics,
cancellation/retry, safe failure messages, response bounds and independent HTTP
deadlines. `node tests/ai-analysis-browser.mjs` exercises the real worker with a
local synthetic model server, prompt editing, page reload during generation,
report review/download, literal model text, phone layout and revoked admin access.
Set `PUPPETEER_MODULE` and `CHROME_PATH` for your local browser installation.
