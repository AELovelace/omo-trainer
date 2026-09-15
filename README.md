# Little Log

Administrator device statistics: [STATISTICS_API.md](STATISTICS_API.md) documents the read-only API, revocable admin tokens, everyone overview and individual drilldown, plus the CrowPanel Advance 7-inch V1.4 companion setup.

A phone-friendly PWA for **lidoll.dev/tracker/** with central SQLite storage and shared lidoll.dev authentication. Two Node services run on the service server: Little Log (4173) and the reusable OpenID Connect identity service (4180). The web server reverse-proxies both over HTTPS.

The interface is styled as a recovered **Chrysalis observation terminal**, using [lidoll.dev](https://lidoll.dev)'s plum, pink, and pale framed borders. The dashboard, record archive, shared sign-in screens, and install icons share the theme. Optional static CRT texture follows the main site's saved preference and respects reduced motion. All fonts and tracker assets are local, including offline use.

The main protocol starts at 50%, applies a fifteen-minute cooldown after a random Hold, and adjusts the chance by five percentage points per completed day within 20-80%. Each actual wetting is classified separately. Nonempty days with Forced + Semi-Forced + Voluntary >= Semi-involuntary + Involuntary decrease the chance; other days, including days with no recorded wettings, increase it. See [GENERATION_TUNING_GUIDE.md](GENERATION_TUNING_GUIDE.md) for day boundaries, enrollment, offline behavior and upgrade details.

Each check-in stores its timestamp, liquids consumed since the previous check-in and diaper number. Rolling is a separate action that records its actual time, selected position, calculated probability, and result. Saving a check-in never rolls; rolling leaves unsaved check-in fields untouched. Enrollment and classified events sync to participant-scoped SQLite alongside check-ins. Existing 0-100% legacy observations remain readable.

The **Record a diaper change** card sits below **Record a wetting**, including
in the mobile Wetting tab. Save the date/time, diaper number being changed and
its final wetting count (including zero for a dry change). Daily totals count
saved changes. The current diaper number carries across midnight until a change
is recorded. The first change on a later day starts the fresh diaper at #1;
later changes that day advance to #2, #3, and so on. Wetting suggestions cover the full period since the last change,
including overnight records; adjust for any unlogged wettings.
New wetting events no longer store a per-diaper total. Historical totals remain
editable, and changes sync and export as separate `diaper-change` records.
Admin analytics includes change counts and mean wettings per completed diaper.

The dashboard includes 7/30/90-day charts, history filters, editing/deletion, CSV exports, and JSON backup/import. A random prompt never restricts when you can use your diaper and never increments wettings automatically.

New participants can choose **Settings & data → Create account**, or register from the shared sign-in page. Registration uses a username and password, then returns through app consent. The account works across registered lidoll.dev apps. Email is not collected; password resets are handled by the administrator. [AUTH_GUIDE.md](AUTH_GUIDE.md) describes registration and its request limits.

The PWA now includes the **Potty chart** from LiDOLL QUEST. It can be linked to the same Chrysalis participant file as observations, with automatic linking on sign-in, offline edits and version-conflict choices. See [Growth Chart setup and behavior](GROWTH_CHART_GUIDE.md).

On mobile (up to 680px wide), the bottom bar switches between **Record liquids**,
**Record wetting**, **Roll**, and **Pattern analysis**. Unsaved form values remain
when switching. The links support browser Back/Forward and offline reopening.

The observation intake field can switch between **mL** and **US fl oz**. The
choice stays on this device; switching converts the draft amount, and saving
rounds to the nearest whole mL for consistent history, analysis and exports.

## Run locally

Install Node 24 or newer, then:

~~~sh
npm ci
node scripts/auth-admin.mjs init
node scripts/auth-admin.mjs create alice
~~~

The administrator create command is optional; it generates a password and displays it once. Participants can also register through the web app after both services start. Run these in separate terminals:

~~~sh
node scripts/auth-server.mjs
node scripts/serve.mjs
~~~

Open **http://127.0.0.1:4173/tracker/** and choose **Settings & data → Sign in with LiD0llID**. On Windows use npm.cmd if PowerShell blocks npm.ps1. No frontend build is required. Use the exact same hostname throughout: localhost and 127.0.0.1 are different cookie origins.

## Your two-server deployment

For your Fedora service server, use the [Fedora deployment and GitHub update scripts](FEDORA_DEPLOYMENT.md): `sudo bash deploy/fedora-deploy.sh` installs the services, and `sudo bash /opt/lidoll/current/deploy/fedora-update.sh` fetches and deploys later updates. The installer preserves configuration and data, tests staged releases, and backs up both stopped databases before switching code.

Use [tracker.env.example](deploy/tracker.env.example) and [auth.env.example](deploy/auth.env.example). Put persistent data directories outside the public web directory. See [AUTH_GUIDE.md](AUTH_GUIDE.md) for production commands, account setup, and adding future apps.

1. **Proxy the complete tracker:** add [nginx-proxy.conf](deploy/nginx-proxy.conf) inside the existing lidoll.dev HTTPS server block. It forwards /tracker/, including the API and callbacks, to your configured service address **10.1.1.23:4173**.
2. **Publish shared authentication:** follow [AUTH_PROXY_SETUP.md](AUTH_PROXY_SETUP.md) to create the complete **auth.sadgirlsclub.wtf** HTTP/HTTPS server configuration and certificate. If a suitable HTTPS block already exists, use [nginx-auth.conf](deploy/nginx-auth.conf) inside it instead. Both options forward to **10.1.1.23:4180**.
3. **Optional direct frontend hosting:** copy only index.html, styles.css, themes.css, theme-init.js, lib/theme.js, lib/reminder.js, app.js, sw.js, manifest.webmanifest, lib/model.js, lib/sync.js, lib/training.js, lib/diapers.js, lib/economy.js, lib/reward-celebration.js, lib/notifications.js, sprites/ (active images 1.png-12.png, animal_01.png-animal_09.png, and sun_01.png-sun_16.png; exclude duplicate scans and _originals/), icons/, and the bundled potty_chart/ into /srv/lidoll/public/tracker/. Use [nginx-static.conf](deploy/nginx-static.conf), which still proxies API/login routes to Node. Central storage requires the backend even with static frontend hosting.

Only the reverse proxy should reach the private service ports. The TLS certificate and HTTPS listener belong to your existing server setup. Validate with nginx -t before reloading. No live server or DNS configuration has been modified by this implementation.

All asset paths are relative. /tracker redirects to /tracker/; the trailing slash is required. A different BASE_PATH works when the registered auth callback is updated to match. There are no analytics, CDN assets, or external frontend scripts.

## Central data and offline sync

**Connected entries are saved centrally** in DATA_DIR/little-log.sqlite. Each verified shared account maps to an app-specific participant ID. The API resolves ownership from the server session, so participants cannot select another person's records. The organizer can export synced entries for analysis; the interface tells participants this before connecting.

Before connection, records stay on this device. Connecting uploads existing local entries and future changes. A cache and durable upload queue stay together under the browser key lidoll.little-log.v1. A lost response can be retried without duplicate records. Version checks detect conflicts between devices, and Settings offers an explicit choice of which version to keep.

Sync runs after changes, when connectivity returns, and every 30 seconds while the page is visible. A closed app must reopen to upload pending changes. The status distinguishes device-only records, waiting changes, conflicts, and confirmed database saves. Expired sessions retain the offline queue until the person signs in again.

Entry records sync; **default preferences remain per device**. Connecting a different account cannot silently upload someone else's device cache. Sign out & clear device ends this app's session and removes its local copy while retaining central records. Deleting connected entries queues central deletions; server tombstones stop old devices from silently resurrecting them. Deletions clear the original record fields from the live table, but older backups/exports can retain them.

Session credentials live in HttpOnly cookies, never in localStorage or JSON exports. The device cache and SQLite files are not encrypted by this app. People sharing a browser profile can access its cached entries, and trusted code on the same web origin can read that cache. A dedicated app subdomain provides stronger browser-origin separation when needed.

Export before clearing unsynced data. Import validates the entire backup, adds new IDs, skips exact duplicates, keeps current defaults, and rejects conflicting IDs without a partial import. Connected imports queue new records for upload. CSV follows the history filters; JSON includes the device's records and defaults without credentials.

Daily liquid summaries sum interval intake on the recorded check-in date. On days containing older cumulative records, they use the highest legacy cumulative amount plus interval intake recorded after the latest legacy snapshot, avoiding overlap. History, editors and exports label the measurement mode explicitly. Intake spanning midnight is assigned to the date of the check-in; the app does not guess when each drink occurred. Counters are snapshots rather than measured volumes. Entries keep their recorded local day and offset after travel. Editing an unchanged timestamp preserves its original offset; changing it uses the device timezone for the chosen date.

## Retrieve the dataset and make backups

Run on the service server using the same tracker environment file or DATA_DIR as the running app:

~~~sh
node --env-file=/etc/lidoll/tracker.env scripts/admin.mjs list
node --env-file=/etc/lidoll/tracker.env scripts/admin.mjs export-csv /private/exports/check-ins.csv
node --env-file=/etc/lidoll/tracker.env scripts/admin.mjs export-json /private/exports/check-ins.json
node --env-file=/etc/lidoll/tracker.env scripts/admin.mjs backup /private/backups/tracker.sqlite
~~~

Exports contain all non-deleted synced entries with participant ID, entry ID, recorded timestamp/offset, local date, the seven tracking fields, source, edit flag, version, and server receipt/update timestamps. They omit usernames, OIDC subjects, and credentials. These are **pseudonymous**, not anonymous, records. The organizer's list command maps participant IDs to account labels when needed.

Output files must be new: commands refuse to overwrite existing exports or the live database. SQLite's online backup API includes committed WAL data consistently. Back up the identity service separately with auth-admin.mjs backup; account IDs, signing keys, and client registrations must be retained together. Keep backups off the service server and schedule them according to the experiment's needs.

To restore the tracker, stop it, restore the SQLite backup to its configured data location, and restart. Restoring an older snapshot can require conflict review on devices with newer versions. Auth restore instructions are in [AUTH_GUIDE.md](AUTH_GUIDE.md).

SQLite is intended for this small installation, with one tracker service and one auth service using persistent local disks. Do not put live database files on ephemeral deployment storage or network filesystems. Node 24's built-in SQLite API may emit an experimental-feature notice; regression tests cover the database behavior used here.

## Offline installation and updates

Visit over HTTPS (localhost works for development) and wait until Settings reports offline support ready. The service worker caches public frontend assets only; it never caches login routes or API responses. Android/desktop browsers can offer installation; Safari uses Share → Add to Home Screen. Test actual installation on the intended phones.

For each deployment changing frontend assets, increment the cache version in sw.js and deploy the complete matching set of public files. The current manual cache is v39-connected-wallet. Keep sw.js revalidated. New workers wait for existing app tabs to close, preventing mixed assets during a check-in.

The Fedora scripts stamp the deployed service worker with the Git commit automatically. Manual deployments still need an explicit cache-version change.

## Guides

- [Shared authentication and future apps](AUTH_GUIDE.md)
- [Fedora installation and GitHub updates](FEDORA_DEPLOYMENT.md)
- [Contributor guide](CONTRIBUTOR_GUIDE.md)
- [Probability and defaults](GENERATION_TUNING_GUIDE.md)
- [User checklist](PLAYER_CHECKLIST.md)
- [Testing guide](TESTING_GUIDE.md)
- [Quest integration status](QUEST_MAKING_GUIDE.md)
- [Dialogue integration status](NPC_DIALOGUE_TREES.md)

The GameMaker runtime and game_editor_gui.py remain in the separate lidollquest repository. The bundled promotional Growth Chart uses no new game/editor schema fields.

## Sticker collection and market

Open **Stickers & market** in Little Log. Synced observations, wettings and diaper changes earn random stickers; chart cells earn separate spendable stars. Bank exchanges and participant listings use whole-number LiDollCoins. Scientific data stays in `little-log.sqlite`; all market balances and trades live in the separate `market.sqlite`. See [ECONOMY_GUIDE.md](ECONOMY_GUIDE.md) for assets, pricing, recovery and backups.

## Tracker themes

Settings ? Theme offers **Little Tracker**, the default pastel design, and **Caregiver Tracker**, the original dark Chrysalis design. The choice is saved on this device and works offline. Both themes retain the same records, chart, ledger and market controls.

Administrators can edit the scrolling home reminder in **Admin console > Reminders**. Save text with **Show this reminder** enabled to publish it to everyone, including signed-out visitors; disable and save to hide it. Notices start hidden, support up to 500 characters, and update visible online pages within 30 seconds.

**Admin console > Reminders > Margin note** controls the separate home-page tips card. Notes support 2,000 characters with line breaks, preview, and a show/hide toggle. They update open online pages automatically, like the scrolling header.

External games can connect to the shared LiDollCoin wallet using the [LiDollCoin API](LIDOLLCOIN_API.md). LiDollQuest links through Settings, then uses online earnings and spending instead of uploading its saved gold balance.

LiDollQuest browser sign-in uses the first-party wallet session described in LIDOLLCOIN_API.md: same-tab LiD0llID sign-in, first consent, automatic return and restore. Deploy the Node service plus public coins/browser.js before the rebuilt game. Browser grants and remembered permissions live only in market.sqlite (schema 4); the external bearer API and scientific-data storage remain separate.

## Personal potty estimates

Pattern analysis includes a per-profile next-wetting model using actual wetting intervals and, when chronological validation supports it, intake timing and a learned fluid-response delay. It runs offline from the existing scientific records and updates after changes or sync. See [PREDICTION_GUIDE.md](PREDICTION_GUIDE.md) for inputs, limits, validation, deployment and browser tests. No database migration or external model service is needed.

Saving an observation opens a theme-aware sticker dialog instead of the saved
toast. Its image and name come from that observation's account-scoped reward
receipt after sync. Offline/guest saves show a pending message; retrying the
lookup never awards another sticker. Dismissing the dialog keeps it closed when
background sync finishes. Wetting/change feedback is unchanged. Deploy the API
and app assets together.

Run `node tests/observation-reward-browser.mjs` with `PUPPETEER_MODULE` (module
file path) and `CHROME_PATH` to check real saved rewards, offline recovery, guest
feedback, focus, and mobile sizing using disposable local accounts.

Admin Analytics includes **Action by position**, **Action by time of day**
(choose 3- or 6-hour bins), and **Daily action score**. Only actual classified
wettings contribute. F=1, SF=2, V=3, SI=4, I=5; the daily event-weighted mean
uses a fixed 1-5 axis and calendar-day spacing with gaps for unrecorded days.
This ordinal coding assumes equal category spacing; it is descriptive rather
than a measure of training effectiveness. Select one participant for an individual
trend. Everyone pools events, so frequent loggers carry more weight. Exact tables
and CSV include event counts and the number of contributing participants.
Position/time tables include per-group totals, and SVG downloads retain the axis.
Times use the saved local offset; date/participant filters apply, but weekly or
monthly grouping does not change the daily score graph. No stored records change.

`tests/admin-actions-browser.mjs` checks these charts, filter controls, fixed
axis, missing-day gaps and mobile layout. Set `PUPPETEER_MODULE` and
`CHROME_PATH` as for the other browser checks.

### Custom XY chart builder

Open **Admin > Advanced Drilldown > Build your own chart**. Select a recorded period or
any available numeric statistic for X, then check up to six Y statistics and
choose their line colors. The 26 available statistics cover recorded activity,
intake, classifications, positions, desperation levels, random outcomes/chance,
wetting intervals, diaper summaries and current chart stars. The participant,
date and day/week/month filters above also apply. Separate-participant mode
uses distinct automatic colors and permits up to twelve lines.

Every point pairs statistics from the same participant/cohort and period.
Numeric X values are sorted numerically, not chronologically. Time axes preserve
calendar gaps; unavailable measurements stay blank. Mean intervals attach each
positive consecutive-event interval to its ending event's period, including
overnight gaps and a previous event before the selected start date. Current
chart stars describe the saved chart, not an immutable reward ledger.

Use raw units for magnitudes or Normalize to compare shapes across units.
Normalization maps each line's minimum/maximum to 0/100; constant lines use 50.
The chart is descriptive: ordinal action scores and observed associations are
not measures of training effectiveness.

**Save PNG** downloads a 2x image, 2,200 pixels wide, including axes, legend,
title and selection context. SVG stays editable. CSV/JSON contain all raw period
rows, including sample counts; JSON also includes chart settings and cohort
identities. X and Y column prefixes avoid duplicate headers. On very large
selections, charts/images show the last 1,000 sorted points per line; the exact
data preview shows 100 rows and downloads retain all rows.

**Save setup** stores only the chosen chart title, axes, colors and display
options in this browser (up to 30 named setups). Loading one recalculates from
the current authorized data and filters. No participant data is stored with
presets. Access revocation clears rendered charts and cancels pending image
exports. No database migration is required; deploy the updated admin assets
and static-file allowlist together.

Run `node --test tests/chart-builder.test.mjs` for aggregation/export checks.
With `PUPPETEER_MODULE` and `CHROME_PATH` set, run
`node tests/chart-builder-browser.mjs` for actual PNG/SVG/CSV/JSON downloads,
selection controls, preset persistence, mobile layout and access cleanup.

The participant webapp keeps its persistent sidebar on desktop. On mobile
(screens up to 680px wide), the **Menu** button in the top bar opens a vertical
drawer, closed by default. Resizing to desktop closes the drawer and restores
the sidebar. Choose a destination, use Close/Escape, or tap the backdrop to dismiss
it. Keyboard focus stays inside the open menu and returns to its opener when
dismissed. Navigation retains form drafts; the bottom mobile recording actions
remain available. Both themes and offline PWA use are covered by
`tests/theme-browser.mjs`. Deploy the app shell and updated service worker
together so installed copies receive the new navigation.

### Performance bonuses

New observations, classified wettings, diaper changes and independent rolls
accepted through participant sync earn coin bonuses. The wallet displays the
actual deposit amount with a cute Performance bonus message. Formulas remain in
server/performance-bonus.mjs and the operator ECONOMY_GUIDE.md, outside the public
asset allowlist. Offline records earn after sync; existing server records and
admin imports are not retroactively credited. Edits, restores and retries do not
issue second bonuses. Market schema 8 preserves prior roll receipts and balances.

Earned observation stickers celebrate once when their artwork loads, with a brief
confetti burst and a quiet synthesized success chime. Reduced-motion preferences
disable confetti. The modal's Sound on/off button remembers this browser's choice.
Closing the modal stops effects; pending and guest saves do not celebrate an
unawarded sticker. Include lib/reward-celebration.js when deploying static assets.

### Random base adjustments

Version 2 rolls have a 2.5% chance each of a persistent +10-point base change,
a persistent -10-point change, or a one-roll 100% chance. The other 92.5% use the
current base. The persistent base stays within 20-80%, alongside the unchanged
daily +/-5-point rule. Roll events replay in timestamp/ID order, then each
completed day's adjustment; edits/deletions of historical records can recalculate
that history. A guaranteed roll never writes 100% into the persistent base.
Version 1 rolls retain their original temporary semantics. Base/actual probability,
modifier and rule version remain in CSV/JSON exports and sync records.

### Optional PWA notifications

Settings > Receive notifications offers opt-in Web Push and quiet hours (22:00-08:00
by default). The browser supplies its IANA timezone; recorded timestamp offsets
remain absolute instants. A server minute timer saves one 1% lottery per account
and local three-hour block. A winning block sends only within 15 minutes of the
latest actual wetting plus that person's mean valid interval. At least 8 usable
intervals over 3 recorded days are required; gaps outside 5-480 minutes, future
records and data older than 90 days are excluded. Missing/stale records produce
no reminder. New wettings update the estimate. Quiet hours and disabled accounts
suppress delivery. Each block is claimed before sending, so a crash may lose a
reminder but cannot repeatedly send it. Expired push endpoints are removed.

Deploy npm dependencies, Node, app assets and service worker together. Generate
stable VAPID keys with npx web-push generate-vapid-keys, put PUSH_VAPID_PUBLIC_KEY,
PUSH_VAPID_PRIVATE_KEY and PUSH_VAPID_SUBJECT (your contact URL/mailto) in the
tracker environment, then restart lidoll-tracker. Do not commit private keys.
The server needs outbound HTTPS to browser push services. Users must explicitly
enable notifications; this cannot be enabled for them by the server. iOS/iPadOS
requires a supported Home Screen web app: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/.

### Admin push messages

When **Send notification** is disabled, the text beside it explains whether server Web Push setup, a subscribed recipient, a title, or a message is missing. On a receiving device, sign in, open **Settings > Receive notifications**, check **Messages from admins**, and enable the device (or save settings for an existing subscription). Then refresh delivery status in the admin panel. A failed availability request disables sending until a successful refresh.

Admin console > Notifications sends a title (80 characters) and message (500 characters) to one selected member or everyone subscribed to **Messages from admins**. The audience is independent of analysis filters. A live preview shows the text before Send notification. Existing reminder-only subscriptions keep admin messages off until the member explicitly enables the new checkbox and saves settings. New subscribers can choose the checkbox when enabling notifications.

The authenticated, CSRF-protected admin endpoints are GET/POST `api/admin/notifications` and POST `api/admin/notifications/cancel`. Queue requests contain `requestId`, `title`, `body`, and `participantId` (empty for all opted-in members); a repeated request ID with identical content returns the existing message. Changing its content returns 409. Messages and device delivery states persist in the scientific database, separate from the market. Queue creation and cancellation appear in the admin audit. Subscription endpoints and encryption keys are never returned to the admin panel.

The minute scheduler sends only to the opted-in audience captured when queued, checks current access/preferences again, respects timezone-specific quiet hours, and expires pending deliveries after 24 hours. Disabling notifications or admin messages cancels pending deliveries; enabling again does not resurrect them. Administrators can cancel remaining queued devices. Revoking the sender's admin role or disabling a recipient prevents pending delivery.

Recent notifications show counts per device: queued, accepted by the push service, failed/uncertain, and skipped/cancelled. Accepted does not confirm display or reading. Devices are claimed before sending; network errors or process crashes are not automatically retried, avoiding duplicate announcements. Failed/expired push subscriptions are cleaned up on 404/410. Transport TTL remains 60 seconds to avoid much-later delivery by an offline push service. Clicking opens Little Log Home; messages cannot set external destinations.

Deploy the backend, admin assets and updated service worker together. Existing VAPID keys are reused. No live messages are sent by the tests; delivery is mocked while API authorization, queue persistence, cancellation and browser controls are exercised.

Notifications use the Little Log sigil: a pastel 192 px icon and a transparent 96 px monochrome badge, following [the notification badge format](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification). Both are generated by `npm run icons`, served by the tracker, and included in the offline shell. Deploy the new `icons/notification-icon.png`, `icons/notification-badge.png`, and service worker together. Close all Little Log windows and reopen after deployment to activate a waiting worker; new notifications will use the updated artwork.


### Community support notifications

Settings > Receive notifications includes **Community support**, checked by default for first-time notification enables. Uncheck it before enabling, or uncheck and save later, to opt out of both sharing and receiving across all devices. On the first startup after deployment, a one-time migration enables Community support for everyone with an existing push subscription, including installations that already have the community_support column. Accounts without subscriptions are unchanged. Later opt-outs survive restarts, re-enabling and new devices; the migration never replays old check-ins. Browser push permission still requires the user's Enable button.

The first new observation, wetting, diaper change or roll received by the server each day creates the same daily check-in used by login bonuses, using the account's pinned timezone. Participating subscribers broadcast a check-in notice with their account display name by default, including for existing members. **Share anonymously** is an optional checkbox (off by default) that hides the sender name across all devices. Names may appear on recipients' lock screens. Record types, amounts, streaks, account IDs and record details are not included. Saving anonymity also hides names on queued notices; already sent pushes cannot be changed. Notices queued while anonymous, including before this update, stay anonymous even if the member later switches to named sharing. Additional records or rolls that day, edits and sync retries do not broadcast. Offline/backdated records qualify on their sync day; old check-ins are never backfilled.

The SQLite queue is committed with the daily check-in and processed by the existing minute scheduler. Recipients are captured when the check-in occurs, excluding the sender. Live preferences, device ownership and account access are checked before each send. Quiet hours defer deliveries for up to 24 hours. Opting out cancels pending messages in both directions; disabling all devices also stops sharing. Network errors are not retried automatically, to avoid duplicate pushes. Push acceptance does not guarantee display. Clicking opens Little Log Home. Deploy the server and versioned service worker together; no new environment settings are needed.


### Friends

The Friends menu offers display-name search, accepted friend requests and shared records. In History, use Share with friend to preview and share one synced record. Friends can read its current saved version; stop sharing from Friends, delete the record or remove the friendship to revoke access. Notifications include an optional Friends only mode for both directions of Community support, independent of anonymous sharing. See [FRIENDS_GUIDE.md](FRIENDS_GUIDE.md) for use, API and deployment details.
