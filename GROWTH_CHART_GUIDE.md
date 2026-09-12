# Growth Chart and Chrysalis files

The promotional Growth Chart from LiDOLL QUEST is bundled at
`/tracker/potty_chart/`. Open it using **Potty chart** in Little Log's navigation
or the installed PWA shortcut. It uses the same manifest, worker, OAuth client
and app session as Little Log. The main website's `/potty_chart/` source also
uses this backend; serve both on the same origin to carry its existing browser
chart through the login redirect.

## Account and storage behavior

Sign in with LiD0llID. The existing authorization-code flow validates PKCE,
state, nonce, issuer, ID-token signature and userinfo subject. Login requests
with `returnTo=growth-chart` return to the bundled chart using the existing
`/tracker/auth/callback` registration. Arbitrary return URLs are not accepted.
An account mismatch offers reauthentication with `prompt=login`.

Signing in automatically links and saves the browser chart to the same
participant ID as that account's observations. Opening the chart with an existing
app session also links it automatically. A fresh device loads the saved chart.
If the browser and file contain different meaningful charts, choose which complete
chart to retain; this pending choice survives reloads and automatic retries.
There is no automatic merge of names, rows or stars. Download a backup before
replacing content you want to keep.

Names, custom rows/notes, stars, refusal count, reveal status and start date are
stored in `growth_charts` in the existing SQLite file. `growth_chart_mutations`
retains retry hashes and revisions without retaining past chart content.
The observation schema stays at version 2; these additive tables do not change
existing observations or IDs. SQLite backups include both. Private operator
exports use:

```sh
node --env-file=/etc/lidoll/tracker.env scripts/admin.mjs export-charts-json /private/exports/charts.json
```


Each chart stores its ordered `rows` array with the user's actual `id`, `label`,
`note`, optional `praise`, and `locked` flag. Each `stars` key is
`YYYY-MM-DD:rowId`. Resolve that ID against the rows in the same participant's
chart, never a global default label or a row's position: users can rename default
rows, create custom rows, and use identical labels for different rows. API
responses, chart backups and administrator chart exports retain both structures.

Renaming a row preserves its ID and dated stars, updating the current label/note
for all those stars. There is no separate history of labels at award time.
Removing a row also removes its stars; clearing resets the chart. The central
document represents the current chart, not an immutable event history.

Observation JSON/CSV exports remain separate. Chart exports include personal
chart text and pseudonymous participant IDs, never OAuth credentials.

`GET /tracker/api/growth-chart` returns the authenticated participant, CSRF token
and `{chart, version, updatedAt}`. A new file has a null chart and version 0.
`POST` accepts `{chart, baseVersion, mutationId}`, requires the same-origin
session and CSRF header, and returns the acknowledged revision. The server
selects ownership from the session, not a request field. Stale writes return 409;
retries with identical IDs/content acknowledge the original revision without
rewriting current data. Validation permits at most 16 rows, 7,000 dated stars,
and a 256 KiB request; the authored locked row cannot be starred or omitted.

Browser saves retain `ldq-growth-chart-v2`, with an added `sync` member storing
the participant, acknowledged base/version and any pending mutation atomically.
Only that browser envelope carries pending offline edits. Account changes cannot
upload another participant's chart. Edits made during an upload remain pending
after its acknowledgement. Sync runs after edits, on reconnect, on return to the
page and every 30 visible seconds. A closed PWA must reopen to sync.

**Clear chart & reset rows** clears stars/history and restores default rows;
it remains linked and queues that change centrally. **Sign out & clear this
browser chart** ends the Little Log app session and clears this chart's local
copy; it leaves the central chart and Little Log's observation cache intact.
Conversely, signing out from Little Log does not erase the separate chart cache.
The shared identity-provider login may remain active. Browser profiles shared
with other people can expose cached content; installed apps may have separate
storage on some platforms. Earlier exports/backups can retain removed data.

## Deploy and update

The bundled `potty_chart/` folder is committed to this repository. Releases do
not need the game checkout at runtime. When changing the authored source, run:

```sh
node scripts/import-growth-chart.mjs /path/to/lidollquest/web/potty_chart
```

The importer copies only public chart files, points its manifest/worker at
Little Log, adjusts the backend base path, and sends game links to the site
root. Deploy it with the matching backend and frontend. The existing full
`/tracker/` proxy already covers all chart routes. For static hosting, copy
`potty_chart/` alongside the public files listed in README; continue proxying
`/tracker/api/` and `/tracker/auth/`. Never copy server scripts or databases into
the web root. Revalidate `sw.js`. Manual releases bump its cache version;
the Fedora deployment stamps the parent worker with the commit automatically.
The chart uses the parent worker inside the PWA, with no nested worker to update.

The source website has its own chart-only worker and manifest. Update that
source worker's version when changing its assets. Both workers cache public
assets only and bypass API, OAuth and query-bearing requests.

Production defaults now use `https://auth.sadgirlsclub.wtf`. Existing installer
environment files are deliberately preserved, so updating code alone does not
change a running issuer. Follow the issuer migration section in AUTH_GUIDE
before changing an existing installation. No live DNS, proxy or service has
been changed by this implementation.

Admin Potty charts tab: the four chart graphs and row-meaning table live beside participant drilldowns. Statistics respect cohort/date filters; the read-only weekly chart and expandable row histories show the complete current saved chart. Missing charts are explicit, and authorization loss clears chart details from memory and the page. `tests/admin-browser.mjs` checks chart navigation, weekly stars, participant switching, date-filter separation and phone layouts.
