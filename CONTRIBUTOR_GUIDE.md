# Contributor guide

Desperation roll mode uses version-3 roll metadata and a device preference independent of the urgency slider. Preserve exact half-percent chances and the protocol's `lastFailureDesperationMode` through validation, sync, deletion handling and all exports. Cooldowns depend on saved records, never the current checkbox. See [GENERATION_TUNING_GUIDE.md](GENERATION_TUNING_GUIDE.md).

## Persistent device sign-in

`server/sessions.mjs` owns the 30-day rolling / 180-day absolute app-session policy. Browser routes must pass their response to `login.session` so the HttpOnly cookie and SQLite expiry advance together; preserve that Set-Cookie header when also issuing wallet cookies. Never revive expired/revoked sessions, rotate credentials on ordinary polling, or trust localStorage account IDs as authentication. Live Little Log permissions remain authoritative. See [AUTH_GUIDE.md](AUTH_GUIDE.md) for deployment and the separate identity-service revocation boundary.

## Admin statistics devices

The read-only statistics API and CrowPanel companion are documented in [STATISTICS_API.md](STATISTICS_API.md). Every token requires an active admin owner, even self-scoped tokens. Keep overview and drilldown calculations aligned through `aggregateAnalysis`; never expose raw entries or extend wallet/report credentials. The companion sketch is maintained in `F:\Langley\Documents\Arduino\lidoll-logger`.

This repository currently contains a standalone browser tracker, not the original game.

- `index.html` and `styles.css`: accessible forms and responsive dashboard.
- The desktop dashboard groups observation and wetting forms in `.left-column`; rolling, charts and recent records use `.right-column`. Both columns stack at the existing narrow-screen breakpoint.
- `#about` in `index.html`, routed by `navigate()` in `app.js`, contains the protocol explanation and daily adjustment history. The tracker keeps the live roll probability and cooldown beside its controls.
- `lib/model.js`: schema validation, timestamps, probability, summaries, import, CSV.
- New `kind: observation` records use `liquidsMode: interval` and carry no roll outcome; standalone `kind: roll` records contain draw metadata and selected position. New check-ins omit position and wetting count; new wetting events omit cumulative counts. `kind: diaper-change` stores the completed diaper's number and final `wettingsCount` (0 allowed). Keep those optional historical fields when validating older records. Keep their UI actions, validation, exports and summary contributions separate. Untyped legacy records retain cumulative intake semantics.
- `lib/diapers.js`: explicit daily change counts, next-diaper suggestions and editable wetting-count suggestions. `.wetting-panels` stacks the cards on desktop; mobile routes `#wetting` and `#change` show each independently without clearing drafts. A change never creates classified events or affects the protocol counts. Update server and frontend together; old clients reject unknown record kinds until refreshed.
- `lib/training.js`: enrollment, stable reporting timezone, completed-day adjustments and original-draw cooldowns; see GENERATION_TUNING_GUIDE.md for rules and migration limits.
- `app.js`: controls, charts, local persistence, durable sync, conflict review, and account connection. Intake can be entered in mL or US fl oz (29.5735295625 mL per fl oz). Keep the unit preference separate from records; preserve the unrounded draft during switches and round once to whole mL at save. Existing record editing and reports remain explicitly labeled mL.
- `lib/sync.js`: local queue, remote reconciliation, tombstones, and explicit conflict resolution.
- `server/database.mjs`: participant-scoped SQLite records, mutation receipts, app sessions, and administrator exports.
- `server/login.mjs` and `server/api.mjs`: OIDC integration, HttpOnly sessions, CSRF enforcement, and authenticated sync.
- `auth/` and `scripts/auth-server.mjs`: shared identity storage, password verification, and the reusable OIDC service.
- `auth/views.mjs`: escaped, uncached registration/sign-in/consent page markup using the shared Chrysalis style.
- `sw.js`: scoped public-shell caching. Bump the cache version on every public-file release.
- `scripts/serve.mjs`: required Node API service, with an explicit public-file allowlist for frontend hosting.
- `scripts/admin.mjs` and `scripts/auth-admin.mjs`: server-local data exports/backups and shared account/client management.
- `scripts/icons.mjs`: dependency-free rasterization of the Chrysalis terminal sigil; regenerate the PNGs with `npm run icons` after artwork changes.
- `tests/`: model, SQLite, auth, sync, HTTP, offline-browser, and connected multi-device/OIDC workflow tests.
- `deploy/fedora-deploy.sh`, `deploy/fedora-update.sh`, and `deploy/fedora.mjs`: Fedora/systemd installation and staged GitHub updates; operational instructions are in `FEDORA_DEPLOYMENT.md`.
- `deploy/release.mjs`: configuration checks, systemd units, firewall rules, and the tested activation/rollback sequence.
- `deploy/command.mjs`: direct command execution with an accessible default working directory before switching Unix users; stage-specific commands supply their checkout explicitly.
- `deploy/nginx-auth-server.conf` and `deploy/nginx-auth-bootstrap.conf`: complete auth reverse-proxy configuration and temporary first-certificate host; installation and renewal instructions are in `AUTH_PROXY_SETUP.md`.

Keep free-form data out of HTML interpolation. Current template inputs are strictly validated enums, numbers, IDs, and timestamps. Any new user-defined text must use `textContent` or equivalent escaping. Validate imports completely before committing them, and write storage successfully before showing a save confirmation.

The Chrysalis theme follows the live lidoll.dev palette: page `#1a0611`, panel `#370f2d`, pink `#ff96c8`, pale rail `#fadadd`, and orchid `#a474d6`. `styles.css` holds the local font stacks and chart colors; SVG charts consume those same CSS variables. The archive seal, redactions, and margin note are presentation, not access-control or sync indicators. Keep actual save status, Chrysalis access, errors, and account consent explicit. The shared identity views in `auth/views.mjs` use the same palette without external styles or fonts.

`CRT FX` controls a static background texture. It shares the main site's `ldq-crt-effect` browser preference, stays separate from observation data, and is disabled by reduced motion. Do not add flashing or obscure form text with overlays. Check desktop, phone, history, settings, editing, and account pages after theme changes. Preserve the storage namespace, OIDC client ID, PWA ID/scope, and export format across visual releases.

Save local entries and their sync queue in one envelope. Retain mutation IDs on retries and base versions on edits; never replay a conflicting later edit as a new write automatically. Keep API ownership tied to the authenticated OIDC subject, not a participant ID supplied in a request. Auth secrets, credentials, database files, and analysis exports must stay outside the public-file allowlist. Do not log request bodies or cookies.

Shared auth follows [AUTH_GUIDE.md](AUTH_GUIDE.md): new apps register distinct client IDs and exact callback URLs, validate code/PKCE/state/nonce and ID-token signatures, and issue their own app sessions. Keep issuer/account identities stable through backup/restore. Dependency versions and lockfile changes belong together; run `npm ci` to reproduce the installed protocol libraries.

Self-registration must always use insert-only account creation. Do not reuse the password-reset path when a username exists. Keep action-bound CSRF, the interaction-cookie check, Origin validation, payload limits, and persisted registration throttles before expensive account creation. Registration grants no app role. The direct tracker signup entry clears any pending automatic connection flag; uploading existing records remains a separate choice afterward. Protocol registration parameters belong in `server/login.mjs` and `scripts/auth-server.mjs`, never client-side password storage.

The header's **Sign in to sync** button opens the same shared identity flow from every page. It keeps save status separate, offers **Connect device** for an authenticated but unconnected device, and leaves first-time upload approval in Settings. Keep it in sync with session changes and expired-session recovery.

Keep shell files LF-terminated through `.gitattributes`. Fedora deployment uses `/usr/bin/node-24`, runs dependency installation/tests without production credentials, and stamps the service-worker cache with the fetched commit. Never put mutable database files in a release directory or automatically restore old data after a failed activation. Changes to the deployment policy require its regression tests and deployment guide to stay in sync.

Use brief comments to explain each function's purpose and non-obvious decisions. Keep PowerShell scripts in `ps/` and Python scripts in `python/` if either is introduced. Update this guide, the probability guide, user checklist, and testing guide when behavior changes. Keep quest/dialogue integration status accurate when game assets arrive.

There is no supplied `game_editor_gui.py` to update. When integrating the original game, first inspect its editor schema and ensure new fields round-trip through both the editor and runtime. Do not invent a parallel game editor in the tracker repository.


## Growth Chart integration (2026-09-12)

The PWA now bundles `potty_chart/` from the game's `web/potty_chart/`.
Use `scripts/import-growth-chart.mjs <source-folder>` to refresh public assets.
Both charts use the existing OIDC session and participant ID; keep the
`growth-chart` API session-owned, CSRF-protected, versioned and uncached.
The browser chart and its retry/ownership metadata share one atomic save.
Mobile quick actions use `#observation`, `#wetting`, `#roll`, and `#analysis`
inside Overview. Keep the existing forms mounted so switching preserves drafts;
CSS limits single-panel display to 680px and below. The fixed bar and toast spacing
include the phone safe area. Desktop retains all dashboard cards.

Sign-in automatically links and uploads a guest chart, or restores the saved
chart on a fresh device. Conflicting first-link content requires a durable
`sync.needsChoice` version choice before uploading. See GROWTH_CHART_GUIDE.md.
Production auth defaults use auth.sadgirlsclub.wtf; existing issuer transitions
require the explicit migration documented in AUTH_GUIDE.md.

Classification includes `semi-forced` (Semi-Forced / SF), ordered between Forced and Voluntary in both create/edit menus. Keep the model allowlist, history labels and protocol counts aligned. SF joins F/V for daily adjustment; existing records are unchanged. Deploy matching frontend/backend files and close older PWA tabs before recording the new category.

Admin Potty charts tab: the four chart graphs and row-meaning table live beside participant drilldowns. Statistics respect cohort/date filters; the read-only weekly chart and expandable row histories show the complete current saved chart. Missing charts are explicit, and authorization loss clears chart details from memory and the page. `tests/admin-browser.mjs` checks chart navigation, weekly stars, participant switching, date-filter separation and phone layouts.

Automatic chart synchronization: Chart sync now combines unsynced edits against the last acknowledged base, retries failed uploads with the same mutation receipt, and refreshes across tabs and every 15 visible seconds. Independent row fields and star additions/removals merge; a pending local edit wins a simultaneous edit to the same field. First-link guest rows with different meanings receive separate IDs and keep their stars. Account mismatches still block upload; storage or combined-size limits report an error without discarding either copy. A closed PWA must reopen to upload offline edits. Admin chart views poll the protected chart-only endpoint every 15 seconds while visible, and refresh on focus or same-origin save notifications. No observation datasets are polled. The shared merge.js asset must ship in both chart shells and offline caches. Browser regression coverage includes actual saved chart edits reaching the admin view, cross-tab draft preservation, automatic guest/offline merges, 409 retries and lost-response receipts.

Potty chart is a native Little Log view at #potty-chart. Navigation keeps the same document and preserves drafts; the app header shows chart sync status on this route. Existing ldq-growth-chart-v2 saves are reused. Old chart URLs and the PWA shortcut lead to the integrated view, and OAuth returns there. Run node scripts/embed-growth-chart.mjs after editing bundled chart markup/styles; the source importer also runs it. Commit index.html and potty_chart/embedded.css with the matching chart scripts and worker. Static deployments must include the updated nginx chart redirects.

Roll desperation: the four-step slider records low/medium/high/crisis on each new roll (displayed Low/Med/High/Crisis), without changing probability or cooldown. History, JSON/CSV backups, database sync and admin exports retain the field. Older rolls omit it and appear as Not recorded in the admin distribution. The chosen level stays selected while switching views and after saving; a new page starts at Low. Tests/desperation.test.mjs covers validation, sync and export round trips; tests/training-browser.mjs checks keyboard steps, saving and mobile draft retention.

## Account economy

`server/reward-bridge.mjs` delivers the scientific database outbox to a separate `market.sqlite`. `server/economy.mjs` owns all integer balances, reward receipts, escrow and transfer transactions. `server/sticker-catalog.mjs` allowlists images from `sprites/`; `lib/economy.js` mounts the gallery and market. Keep health payloads out of the market database and preserve request IDs across uncertain network results. See ECONOMY_GUIDE.md before changing currency rules or backups.

The six mobile header destinations use one-word labels (Home, History, Settings, Chart, Stickers, About) in a fixed six-column grid. Keep `#admin-nav` outside that grid: it is a role-controlled shortcut fixed at the bottom right, above the mobile recording bar. Its visibility still comes from the server session role.

## Themes

`theme-init.js` applies the allowlisted `little-log.theme` preference before CSS paints. `lib/theme.js` handles the Settings selector, cross-tab updates, storage failures and theme-color metadata. `themes.css` scopes all Little Tracker overrides to the root data-theme attribute, including the embedded chart palette; the original `styles.css` remains Caregiver Tracker. Keep both theme assets in the server allowlist and service-worker shell, and keep the ledger monospace. Avoid regenerating embedded chart CSS just to change its theme. The pastel theme starts with CRT off unless the user explicitly saved a CRT preference; Caregiver retains its original default-on behavior.

Admin reminders replace the home page's recovered-interface strip. The scientific database stores a single versioned notice in `admin_settings`, with metadata-only auditing. Public `GET api/reminder` exposes only enabled text; `GET/POST api/admin/reminder` require live admin authorization and publishing also requires CSRF. Conflicting edits return 409. The main app polls every 30 seconds while visible and refreshes on focus, reconnect and same-origin publication broadcasts. Failed/offline requests hide stale notices. Reminder text is rendered with `textContent`.

New wettings use `diaperAtTime` to assign their diaper number automatically at save time, including backdated events. Untouched event times retain seconds so a wetting immediately after a change belongs to the next diaper. Historical wetting numbers remain editable in History.

Margin notes share the notice editor and live refresh mechanism with the header, but use a separate `margin-note` key and version in `admin_settings`. `GET api/margin-note` exposes only published text; `GET/POST api/admin/margin-note` enforce admin access, with CSRF on writes. Notes allow 2,000 characters and preserve line breaks. Existing installations start with the original margin quote until an administrator changes or hides it.

External wallet routes are isolated in `server/coin-api.mjs` and `server/coin-api-store.mjs`. They use app-scoped device grants and the market database only. Never introduce an absolute balance setter or accept these bearer credentials on scientific endpoints. See LIDOLLCOIN_API.md for consent, CORS, integer transactions and replay/refund contracts.

LiDollQuest browser sign-in uses the first-party wallet session described in LIDOLLCOIN_API.md: same-tab LiD0llID sign-in, first consent, automatic return and restore. Deploy the Node service plus public coins/browser.js before the rebuilt game. Browser grants and remembered permissions live only in market.sqlite (schema 4); the external bearer API and scientific-data storage remain separate.

## Personal potty estimates

Pattern analysis includes a per-profile next-wetting model using actual wetting intervals and, when chronological validation supports it, intake timing and a learned fluid-response delay. It runs offline from the existing scientific records and updates after changes or sync. See [PREDICTION_GUIDE.md](PREDICTION_GUIDE.md) for inputs, limits, validation, deployment and browser tests. No database migration or external model service is needed.


### Connected-game stars
The shared wallet API now supports explicitly authorized star credit/debit/refund operations in market schema 5. See LIDOLLCOIN_API.md for migration and deployment order. Run `npm test` for currency isolation, legacy receipts/consent migration, integer and balance limits, star scopes, chart preservation, ledger persistence, refunds and browser origin/CSRF checks.


### Current diaper across midnight
`lib/diapers.js` derives the active diaper from the latest actual change and subsequent records, independent of calendar rollover. Suggested wetting totals span that wear period; daily statistics still count only changes saved on that date. The change form uses its exact event timestamp for backdated suggestions. No stored records or database schemas are rewritten.

The first change after a date rollover starts the next diaper at #1, while the change record retains the completed diaper's prior number and final wetting count. Later changes on that recorded local date increment normally. No midnight event or database migration is introduced.


## Games page

[Games guide](GAMES_GUIDE.md) covers the four MommyBot web games, including Prism Drop (`balldrop`). `lib/games.js` handles connectivity, `server/games.mjs` provides fixed redirects using `LIDOLLBOT_PUBLIC_ORIGIN`, and `#games` shares existing navigation and themes. Keep game databases, wallet grants and payment logic in MommyBot; never forward PWA credentials or cache game redirects/API responses.


## Additional event choices

Bedwetting and Used the potty are separate choices in Record a wetting and its edit dialog. Both retain their category through history, JSON/CSV and account sync. Used the potty does not increase the suggested diaper wetting total. Both count as recorded events for interval estimates, but have no F/SF/V/SI/I probability weight, ordinal action score or category performance bonus; a day with none of the original five categories follows the existing empty-day rule.


## Shared recording reward modal

All three new-record save handlers call showRecordReward(entry) after a successful local commit. The shared dialog keeps its existing observation-reward DOM IDs for compatibility; recordReward tracks the exact record ID and account while sync delivers the existing server entitlement. Editing records does not reopen the reward modal.


## Login bonuses and diamonds

Daily attendance is inserted only after a successful batch accepts a new observation, wetting, diaper change or roll. Keep the scientific receipt and outbox atomic, market delivery idempotent, and diamond API permissions explicit. See LOGIN_BONUSES_GUIDE.md for boundaries and migration details.

## Admin AI analysis

The admin-only AI analysis panel uses a supervised worker thread and a private SQLite job queue. Keep inference out of request handlers; retain live role/CSRF checks, lease ownership checks and prompt/source snapshots. Setup, scheduling and privacy boundaries are in [AI_ANALYSIS_GUIDE.md](AI_ANALYSIS_GUIDE.md).

## Registration grants

New participant creation atomically stages a one-time 50-coin welcome entitlement. Keep its market receipt, credit and ledger entry transactional; never award from ordinary wallet reads or repeated sign-ins. Existing accounts are excluded. See [ECONOMY_GUIDE.md](ECONOMY_GUIDE.md).

## Report API integrations

MommyBot can read completed nightly and explicitly shared analysis documents using a dedicated admin-issued `reports:read` token. Feed and document reads must require either a scheduled daily job or a manual job with `share_with_bot=1`. Only an authenticated admin queue action can opt in a manual run; private runs must never leak through direct IDs or query filters. Keep credentials separate from wallet grants and recheck the issuing admin's live role. Commit `ai_report_feed` cursors with completed documents, using completion order rather than job creation order. See [AI_REPORT_API.md](AI_REPORT_API.md).


Community support uses server/community-support.mjs and the daily check-in receipt returned by server/login-bonuses.mjs. Queue creation belongs inside the sync transaction; never send push requests in that transaction or broadcast from browser events. Use only the saved account display name for named payloads. Default community_anonymous to false, preserve saved anonymity on updates, and snapshot anonymity on queued events. Legacy events remain anonymous; selecting anonymity also protects pending events. Recheck both sides' preferences before delivery, and preserve opt-outs on subscription updates. The notification_migrations marker community-support-existing-subscribers-v1 atomically enrolls existing push subscribers once; never remove this marker or rerun enrollment on each startup.


Friends: server/friends.mjs owns relationship and per-record grants; lib/friends.js renders names and records using text nodes. Never grant timeline access from a friend request or community notification. Keep accepted-friend and enabled-account checks on every shared read, revoke grants on deletion/removal, and retain CSRF and preview-version checks. Friends-only queues must check both members at creation and delivery and permanently cancel ineligible pending deliveries. See FRIENDS_GUIDE.md.


## Status updates and friend messages

See [SOCIAL_GUIDE.md](SOCIAL_GUIDE.md). Keep live audience checks on every picture
read, accepted-friend checks on conversations, and retry receipts across
friendship deletion. Re-encode submitted pictures with the pinned sharp
dependency before storage. Never cache social API responses in the PWA. Deploy
the updated Nginx upload location alongside the backend and frontend changes.


Social reactions and activity: likes/comments/post notices commit with their
source content. server/activity.mjs stores account history separately from
device delivery. Preserve default-on social preference columns only at their
initial migration; never reset saved opt-outs. Check live audiences at read and
delivery time, and keep withdrawn notification receipts to prevent replay.
Admin social moderation requires a current role, CSRF and a reason; only
reported private messages are reviewable. See SOCIAL_GUIDE.md for endpoints.

Activity filters community-checkin entries by the recipient's current saved
community_support preference. Apply that filter before pagination and unread
counts, and to read updates; do not permanently withdraw history solely because
this display preference is off. Other stored push types remain visible.

Social navigation lives in the #page-social wrapper, with one main-menu link
and #social-navigation bottom links. Existing page IDs and feed/message/activity/
friends hashes remain compatible. app.js maps #social to Feed and aligns the
bottom bar to main content on resize; lib/social.js recognizes the alias when
loading data. Keep the recording bar hidden only while Social is active.

The Post composer is #page-post, separate from #page-feed. Its #post route loads
only api/social/session for identity and CSRF. Keep draft state in memory across
tab switches and retain the existing request ID on uncertain publishing retries.

Main-menu icons use shared SVG symbols in index.html and inherit theme colors.
Little Log/My Star Chart retain the overview/potty-chart routes. Keep new menu
symbols distinct from the Social bottom-bar icons and bump the shell cache when
changing the public markup.

Profile pictures: `lib/profile.js` manages Settings uploads and `lib/avatar.js`
renders versioned avatars with an initial fallback. `social_profiles` stores one
sanitized JPEG per member, plus a version/request hash retained after removal.
`GET/POST api/social/profile` is session-owned; POST requires CSRF, requestId,
loaded version (initially null) and picture `{data: base64}` or null to remove.
Compare versions again after decoding to prevent concurrent overwrites.
`GET api/social/avatar?owner=ID&version=VERSION` requires an enabled session and
enabled target. Return no-store JPEGs, never a public/static image URL. Friend,
post and comment identities include avatarVersion when a picture exists.
Admins review the profiles view and remove-profile action with a reason and
reviewed version; the audit log records removal. Restrictions also block avatar
writes. Keep avatar modules in the static allowlist and service-worker shell,
while keeping every image API outside the cache. The Social bottom bar now
contains Post, Feed, Friends & search, Messaging, Notifications and Profile.

`lib/picture-upload.js` handles both post photos and avatars. Accept originals
up to 100 MiB, decode locally, resize, and measure the encoded JPEG against its
byte budget. Profiles use a 128 KiB JPEG budget. Posts normally keep up to
1600px and 1400 KiB JPEGs; on an explicit HTTP 413 only, share 168 KiB of JPEG
data between all images before one automatic retry (under 256 KiB with JSON).
Retain the compact request body for uncertain-response retries, and check the
original page/account generation before and after preparing the retry. Never
compact and retry a timeout: the original body might already have committed.

Admin Participants uses current, non-deleted tracker entries from the loaded
dataset for its selector, analytics totals and chart cohorts. Sign-in alone,
wallet balances, social content and chart setup do not add a participant.
User management still lists accounts for role/access administration; its data
and prediction shortcuts are disabled for accounts without records. Full
backup exports retain all accounts and chart definitions.

`lib/post-gallery.js` renders posted photo galleries using native horizontal
scrolling and CSS scroll snap. Keep composer previews editable as a grid.
Gallery buttons and keyboard navigation follow the current scroll position,
respect reduced motion and retain the existing authenticated image URLs.

Social profiles use `#profile` for the current member and `#profile?id=ID` for
another member. `GET api/social/member` accepts id/before and returns only
minimal member identity, self/friend flags and a page of currently readable
posts. Keep owner/audience filtering before pagination and recheck enabled
accounts and accepted friendship on every request. `createIdentity` renders
profile anchors using text nodes. Feed and profile share post cards and gallery
cleanup; conversation names and Message buttons are separate controls.

Social's compact shell applies only at `max-width:680px`. `#social-content`
scrolls between the topbar and social navigation; Messages instead scrolls its
inbox or message history and keeps the reply composer visible. Desktop wrappers
use `display:contents` to preserve the existing document flow. The visual
viewport height handles reduced space above a mobile keyboard; clipping the body
prevents focus from scrolling a second container behind the shell.

`lib/social.js` filters mobile Inbox/Unread/All mail/Archived views locally and
keeps unsent replies only in memory. Do not mark a hidden mobile thread read.
`POST api/social/messages/archive` accepts `{participantId, archived}` and uses
the authenticated session's owner plus CSRF protection. `friend_message_archives`
stores each viewer's latest archived sequence; newer messages resurface the
thread. Deleting the friendship cascades archive state. Keep server permissions,
read markers and offline cleanup independent of the layout.

`lib/record-sharing.js` manages account-wide, default-off timeline posting through
`GET/POST api/social/record-settings`. Writes require session, CSRF and the loaded
integer version; stale devices must refresh before changing consent or audience.
This preference is independent of notification subscriptions.

`social.syncRecordPost` runs synchronously inside the accepted record transaction.
Only new wettings, diaper changes and interval liquid observations can create posts.
Liquid summaries use the canonical `liquidsMl` amount; untyped legacy cumulative
records and rolls stay excluded. The `(owner,entry_id)` link
in `social_record_posts` is retained after post deletion to prevent resurrection.
Corrections retain the original audience; deletion or conversion to a nonshared
record kind withdraws the post and activity. Admin imports call the same hook
only to correct existing posts. Never call asynchronous `publish()` from the sync
transaction or expose raw record payloads through Social. Posting restrictions
suppress new automatic posts while allowing the underlying tracker save.

Notification preferences `friendWettings`, `friendChanges` and `friendLiquids`
filter automatic record-post pushes beneath the existing `friendPosts` master
switch. `activity.pushEnabled` resolves the linked entry kind at queue, cancel
and delivery time, so pending posts from before the update respect opt-outs too.
Defaults are on; omitted fields preserve saved choices for older clients and
new devices. Keep stored activity and the author's sharing preferences separate.
