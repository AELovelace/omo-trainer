# Little Log

A phone-friendly PWA for **lidoll.dev/tracker/** with central SQLite storage and shared lidoll.dev authentication. Two Node services run on the service server: Little Log (4173) and the reusable OpenID Connect identity service (4180). The web server reverse-proxies both over HTTPS.

The interface is styled as a recovered **Chrysalis observation terminal**, using [lidoll.dev](https://lidoll.dev)'s plum, pink, and pale framed borders. The dashboard, record archive, shared sign-in screens, and install icons share the theme. Optional static CRT texture follows the main site's saved preference and respects reduced motion. All fonts and tracker assets are local, including offline use.

Each check-in stores timestamp with timezone offset, cumulative daily liquids in mL, position, diaper number that day, wettings in that diaper, whole-number pee probability (0–100%), and pee/hold result. Records also have IDs, random/manual source, edit flags, and server revisions.

The dashboard includes 7/30/90-day charts, history filters, editing/deletion, CSV exports, and JSON backup/import. A random prompt never restricts bathroom access or increments wettings automatically.

## Run locally

Install Node 24 or newer, then:

~~~sh
npm ci
node scripts/auth-admin.mjs init
node scripts/auth-admin.mjs create alice
~~~

The create command generates a password and displays it once. Run these in separate terminals:

~~~sh
node scripts/auth-server.mjs
node scripts/serve.mjs
~~~

Open **http://127.0.0.1:4173/tracker/** and choose **Settings & data → Sign in with lidoll.dev**. On Windows use npm.cmd if PowerShell blocks npm.ps1. No frontend build is required. Use the exact same hostname throughout: localhost and 127.0.0.1 are different cookie origins.

## Your two-server deployment

For your Fedora service server, use the [Fedora deployment and GitHub update scripts](FEDORA_DEPLOYMENT.md): `sudo bash deploy/fedora-deploy.sh` installs the services, and `sudo bash /opt/lidoll/current/deploy/fedora-update.sh` fetches and deploys later updates. The installer preserves configuration and data, tests staged releases, and backs up both stopped databases before switching code.

Use [tracker.env.example](deploy/tracker.env.example) and [auth.env.example](deploy/auth.env.example). Put persistent data directories outside the public web directory. See [AUTH_GUIDE.md](AUTH_GUIDE.md) for production commands, account setup, and adding future apps.

1. **Proxy the complete tracker:** add [nginx-proxy.conf](deploy/nginx-proxy.conf) inside the existing lidoll.dev HTTPS server block. It forwards /tracker/, including the API and callbacks, to your configured service address **10.1.1.23:4173**.
2. **Publish shared authentication:** follow [AUTH_PROXY_SETUP.md](AUTH_PROXY_SETUP.md) to create the complete **auth.lidoll.dev** HTTP/HTTPS server configuration and certificate. If a suitable HTTPS block already exists, use [nginx-auth.conf](deploy/nginx-auth.conf) inside it instead. Both options forward to **10.1.1.23:4180**.
3. **Optional direct frontend hosting:** copy only index.html, styles.css, app.js, sw.js, manifest.webmanifest, lib/model.js, lib/sync.js, and icons/ into /srv/lidoll/public/tracker/. Use [nginx-static.conf](deploy/nginx-static.conf), which still proxies API/login routes to Node. Central storage requires the backend even with static frontend hosting.

Only the reverse proxy should reach the private service ports. The TLS certificate and HTTPS listener belong to your existing server setup. Validate with nginx -t before reloading. No live server or DNS configuration has been modified by this implementation.

All asset paths are relative. /tracker redirects to /tracker/; the trailing slash is required. A different BASE_PATH works when the registered auth callback is updated to match. There are no analytics, CDN assets, or external frontend scripts.

## Central data and offline sync

**Connected entries are saved centrally** in DATA_DIR/little-log.sqlite. Each verified shared account maps to an app-specific participant ID. The API resolves ownership from the server session, so participants cannot select another person's records. The organizer can export synced entries for analysis; the interface tells participants this before connecting.

Before connection, records stay on this device. Connecting uploads existing local entries and future changes. A cache and durable upload queue stay together under the browser key lidoll.little-log.v1. A lost response can be retried without duplicate records. Version checks detect conflicts between devices, and Settings offers an explicit choice of which version to keep.

Sync runs after changes, when connectivity returns, and every 30 seconds while the page is visible. A closed app must reopen to upload pending changes. The status distinguishes device-only records, waiting changes, conflicts, and confirmed database saves. Expired sessions retain the offline queue until the person signs in again.

Entry records sync; **default preferences remain per device**. Connecting a different account cannot silently upload someone else's device cache. Sign out & clear device ends this app's session and removes its local copy while retaining central records. Deleting connected entries queues central deletions; server tombstones stop old devices from silently resurrecting them. Deletions clear the original record fields from the live table, but older backups/exports can retain them.

Session credentials live in HttpOnly cookies, never in localStorage or JSON exports. The device cache and SQLite files are not encrypted by this app. People sharing a browser profile can access its cached entries, and trusted code on the same web origin can read that cache. A dedicated app subdomain provides stronger browser-origin separation when needed.

Export before clearing unsynced data. Import validates the entire backup, adds new IDs, skips exact duplicates, keeps current defaults, and rejects conflicting IDs without a partial import. Connected imports queue new records for upload. CSV follows the history filters; JSON includes the device's records and defaults without credentials.

Daily liquid summaries use the highest cumulative snapshot, never the sum of repeated snapshots. Counters are snapshots rather than measured volumes. Entries keep their recorded local day and offset after travel. Editing an unchanged timestamp preserves its original offset; changing it uses the device timezone for the chosen date.

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

For each deployment changing frontend assets, increment the cache version in sw.js and deploy the complete matching set of public files. The current cache is version 2. Keep sw.js revalidated. New workers wait for existing app tabs to close, preventing mixed assets during a check-in.

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

The original game, trainer source, and game_editor_gui.py were not supplied. This is the standalone tracker implementation; no absent game editor is claimed to have been updated.
