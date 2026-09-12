# Testing guide

## Automated regression tests

```sh
node --test tests/*.test.mjs
```

These cover all 101 probability settings, rejection sampling, cumulative snapshots, calendar boundaries, schema/import validation, CSV fields, SQLite persistence and backups, participant isolation, idempotent retries, transaction rollback, version conflicts, deletion tombstones, app sessions, password hashing/reset/disable, OIDC adapter persistence, and login throttling. HTTP checks verify public assets, redirects, headers, and rejection of unauthenticated or cross-origin data access. Databases use isolated directories under ignored `artifacts/`.

`tests/training.test.mjs` covers daily ties, empty days, both bounds and movement away from them, completed-day-only adjustments, legacy snapshots, DST/timezones, deterministic enrollment selection, cooldown boundaries, original results surviving corrections, typed event backups/exports, multi-device synchronization, and migration from SQLite version 1 without losing records or retry receipts.

`tests/observations.test.mjs` verifies interval sums, overlapping legacy cumulative snapshots, date attribution, separation of draw and observation fields, measurement-mode validation/exports, retry idempotency, second-device synchronization and totals after edits/deletions. The browser workflow verifies observation editing and intake reset; the protocol browser workflow checks that rolling preserves an unfinished observation and that saving during cooldown never creates another roll.

Historical-field coverage verifies that roll position and older per-diaper totals survive SQLite, exports and second-device sync. New totals belong to `diaper-change` records. `tests/diapers.test.mjs` covers dry changes, daily totals, next-diaper suggestions, preserved historical counts, classification/cooldown isolation, sync, corrections, deletion and CSV/JSON round trips. The protocol browser suite records two changes, checks next-day reset and edits/deletes a change, while verifying the new card stays below the wetting card on mobile.

`tests/registration.test.mjs` starts an isolated auth service and uses real OIDC interactions to test registration pages, missing/expired cookies, invalid or wrong-action CSRF tokens, foreign origins, server-side field validation, escaped error output, normalized usernames, replay rejection, duplicate protection, and durable throttling. `tests/auth.test.mjs` also races two account creations and confirms only one password wins, with disabled accounts remaining protected.

## Deployment regression checks

`node --test tests/deploy.test.mjs` exercises activation sequencing, rollback, backup failures, first-deploy failures, environment validation, firewall source restrictions, and systemd isolation without touching host services. A real temporary Git repository also verifies fetch, detached staging, unchanged-commit detection, and preservation of the previous release. Git must be installed for this test. Run `bash -n deploy/fedora-deploy.sh` and `bash -n deploy/fedora-update.sh`, plus `node --check deploy/fedora.mjs`, for script syntax. The Fedora installer runs the complete `.test.mjs` suite before stopping the live services; it does not launch browser tests.

Actual dnf/systemd/SELinux/firewalld integration must be verified on Fedora. Follow [FEDORA_DEPLOYMENT.md](FEDORA_DEPLOYMENT.md), including a public-domain sign-in check after configuring the reverse proxy.

The command-runner regression launches real child processes from a temporary operator checkout, verifying they default to `/` while explicit staging directories still work. Unix user switching and private-home permissions require the Fedora host to verify end to end.

## Browser workflows

Start `node scripts/serve.mjs` in another terminal. The optional browser runner uses Puppeteer with an installed Chrome/Chromium. Install the testing dependency with `npm install --no-save --package-lock=false puppeteer-core`, or set `PUPPETEER_MODULE` to an existing Puppeteer module file. Set `CHROME_PATH` to the browser executable and run:

```sh
node tests/browser.mjs
node tests/training-browser.mjs
```

`TEST_URL` defaults to `http://127.0.0.1:4173/tracker/`. The runner uses an isolated browser context and synthetic data, so it does not access normal Chrome-profile records. It writes screenshots and test-only backup files to ignored `artifacts/`.

The workflow covers independent observation logging and interval intake totals, daily carry-forward/reset, independent wetting counts, persistence after reload, charts, filters, editing, JSON/CSV downloads, valid and invalid imports, preferences, offline reload and saving, 390px phone layout, deletion, quota errors, and corrupt-data recovery. Screenshot fixtures are synthetic; the application ships with an empty history.

The protocol browser workflow uses a controlled clock and deterministic test-only RNG to verify blocked repeat rolls, exact countdown expiry, wetting/observation logging during cooldown, preservation of unsaved intake during a roll, offline reload, midnight decreases, empty-day increases, retrospective corrections, historical probability preservation, wetting filters/deletion, and all routes at six viewport widths. It writes `artifacts/protocol-desktop.png` and `artifacts/protocol-mobile.png`.

It also checks that the Chrysalis CRT toggle persists through reload, switches off under reduced motion, and restores the saved preference when that media setting clears. For visual releases, inspect desktop and phone screenshots, chart/legend colors, visible focus rings, dark native date/select controls, and sign-in/consent contrast. Check all four routes (Overview, Record archive, Settings, and About) at 320, 390, 680, 768, 1024, and 1440 pixels for document overflow. The icon generator and HTTP tests cover all install-icon sizes; visual inspection verifies the sigil itself.

## Connected browser and shared-auth workflows

With the same Puppeteer and CHROME_PATH configuration, run:

```sh
node tests/connected-browser.mjs
```

This runner starts its own isolated tracker and identity services on ports 43173 and 43180, creates synthetic Alice/Bob accounts, and stops only its own processes afterward. It exercises the full OIDC authorization-code/PKCE login and consent flow, migration of local entries, HttpOnly cookies and CSRF checks, another device restoring the same account, offline reload and reconnect, participant isolation, conflicting edits, central analysis export, sign-out, and narrow-screen settings. A separate registered future-app client verifies shared sign-on with the same stable subject and rejects authorization-code replay.

Alice is created through the web registration form, while Bob uses administrator provisioning. The browser verifies password-confirmation errors, duplicate-name rejection, 320/390px layout, consent after signup, explicit local-record upload, and subsequent sign-in on another device. Registration screenshots are saved alongside the other synthetic artifacts before entering passwords.

The second device signs in using the header button from Record archive. The suite confirms that authenticated but unconnected users see **Connect device**, that it opens and focuses the Settings connection action, and that the header button disappears once connected.

The connected suite also syncs enrollment and a classified wetting to the second device, compares displayed chances, and verifies those typed records appear in the central analysis export.

## Release checks on the target host

1. Verify `/tracker` redirects to `/tracker/`, all manifest icons return 200 with the correct MIME types, and `/tracker/sw.js` revalidates.
2. Check the site over HTTPS and install on real iOS/Safari and Android/Chrome devices. Browser automation does not verify the native installation menus.
3. Make a check-in, close/reopen, then switch offline and repeat. Check storage separately in browser and installed app on platforms that isolate them.
4. Use keyboard-only navigation, native radio arrow keys, a screen reader, and chart data tables. Check 200% zoom and a narrow phone viewport.
5. With two tabs, change records in one and verify the other refreshes. An already-open edit must reject an entry changed in the other tab.
6. Export before clearing browser data; import afterward and compare fields. Confirm entries upload only through the authenticated app API, the API returns no-store, and login credentials never appear in URLs, localStorage, or exports.
7. Bump the service-worker cache version, deploy the full app, and verify the new version activates after all old app tabs close.
8. On the production proxy, verify HTTPS discovery/keys, exact callback configuration, Secure/HttpOnly cookies, and trusted proxy headers. Confirm both databases survive a service restart and both database backups can be restored in an isolated environment.

Nginx snippets are deployment templates; validate them against the real server configuration with `nginx -t`. Live domain deployment, real-device installation, and screen-reader checks require the actual hosting/devices and are not implied by local tests.

For a new auth proxy host, follow [AUTH_PROXY_SETUP.md](AUTH_PROXY_SETUP.md): validate the HTTP bootstrap before certificate issuance, then validate the complete HTTPS configuration before reload. Check HTTP redirects to the fixed auth origin, certificate challenge URLs remain local, HTTPS discovery reports the correct issuer, and the real OIDC sign-in succeeds. Verify Certbot renewal with `certbot renew --dry-run` and confirm a renewal schedule and Nginx reload hook exist.


## Intake units

`tests/training-browser.mjs` checks conversion of 250 mL, saving 12.5 US fl oz as
370 mL, repeated toggling without draft drift, blank and invalid amounts, the
maximum allowed intake, reset after saving, preference after offline reload,
and layout at 320px. Saved records and record editing continue to use whole mL.

## Mobile quick actions

`tests/training-browser.mjs` checks the bottom bar at 320/390/680px, all five
panels, unsaved form retention, Back/Forward, return from Settings, offline
reopening, touch targets, bottom clearance and the unchanged desktop dashboard.
On a real phone, also check the home-indicator safe area and form scrolling with
the keyboard open. The bar switches panels without saving records or rolling.

## Linked Growth Chart (2026-09-12)

`npm test` includes growth-chart.test.mjs: bounded validation, SQLite persistence,
participant isolation, CSRF/origin checks, stale writes, lost-response receipts,
clearing and explicit issuer migration/collision rollback. Row-meaning coverage
checks custom labels/notes, renames, reordered rows, duplicate labels, participant
isolation, database reopening and operator JSON exports.

Run `node tests/growth-chart-browser.mjs` with `PUPPETEER_MODULE` pointing to an
installed Puppeteer module and `CHROME_PATH` pointing to installed Chrome.
It creates temporary local auth/tracker services and synthetic accounts under
artifacts/, exercises real OAuth/consent and the chart callback, verifies
automatic linking, renamed/custom row and star restoration on a second device,
fresh-device/session restore, automatic first-link merging,
automatic offline merging, lost-response
retries, account isolation, clearing and phone layout. It does not contact or
change production. A restricted environment may need permission to start the
headless browser. Actual installation and shared browser/installed-app storage
still need testing on the intended phones. See GROWTH_CHART_GUIDE.md.

Semi-Forced coverage in `tests/training.test.mjs` verifies JSON/CSV validation, participant-scoped SQLite sync and second-device restore, SF-only completed days, ties with involuntary events and today's next-day preview. Check both Classification menus show F, SF, V, SI, I in that order; saving/editing SF must retain its history label and About-page count.

Admin chart legends: at desktop and 320px widths, verify every chart has readable series labels beside 9px color keys; the intake scatter legend explains its points and both axes. Color keys must not inherit the full plot size.

Admin Potty charts tab: the four chart graphs and row-meaning table live beside participant drilldowns. Statistics respect cohort/date filters; the read-only weekly chart and expandable row histories show the complete current saved chart. Missing charts are explicit, and authorization loss clears chart details from memory and the page. `tests/admin-browser.mjs` checks chart navigation, weekly stars, participant switching, date-filter separation and phone layouts.

Admin chart freshness regression: change a participant chart through its own UI after the admin dataset loads, wait for sync, then open View chart. Verify renamed/new rows and all saved stars match the participant chart and database. Drilldowns and participant selections fetch current data; failed reads must not silently display the older snapshot.

Automatic chart synchronization: Chart sync now combines unsynced edits against the last acknowledged base, retries failed uploads with the same mutation receipt, and refreshes across tabs and every 15 visible seconds. Independent row fields and star additions/removals merge; a pending local edit wins a simultaneous edit to the same field. First-link guest rows with different meanings receive separate IDs and keep their stars. Account mismatches still block upload; storage or combined-size limits report an error without discarding either copy. A closed PWA must reopen to upload offline edits. Admin chart views poll the protected chart-only endpoint every 15 seconds while visible, and refresh on focus or same-origin save notifications. No observation datasets are polled. The shared merge.js asset must ship in both chart shells and offline caches. Browser regression coverage includes actual saved chart edits reaching the admin view, cross-tab draft preservation, automatic guest/offline merges, 409 retries and lost-response receipts.

Potty chart is a native Little Log view at #potty-chart. Navigation keeps the same document and preserves drafts; the app header shows chart sync status on this route. Existing ldq-growth-chart-v2 saves are reused. Old chart URLs and the PWA shortcut lead to the integrated view, and OAuth returns there. Run node scripts/embed-growth-chart.mjs after editing bundled chart markup/styles; the source importer also runs it. Commit index.html and potty_chart/embedded.css with the matching chart scripts and worker. Static deployments must include the updated nginx chart redirects.

Roll desperation: the four-step slider records low/medium/high/crisis on each new roll (displayed Low/Med/High/Crisis), without changing probability or cooldown. History, JSON/CSV backups, database sync and admin exports retain the field. Older rolls omit it and appear as Not recorded in the admin distribution. The chosen level stays selected while switching views and after saving; a new page starts at Low. Tests/desperation.test.mjs covers validation, sync and export round trips; tests/training-browser.mjs checks keyboard steps, saving and mobile draft retention.

## Separate market database

Run `node --test tests/economy.test.mjs` for reward receipts, existing imports, separate star currency, bank conversion and inventory, distinct demand and expiry, escrow, swaps, insufficient funds, CSRF/account isolation, unavailable market recovery and replay after a market commit. The isolation regression checks that science has no market tables and market has no scientific records or sessions.

With PUPPETEER_MODULE and CHROME_PATH configured, run `node tests/economy-browser.mjs`. It starts disposable local storage, loads the actual sprite collection, and verifies actual image loading, five viewport widths, bank sales, peer purchases, an interrupted response retried after reload, and sign-out. Never point test DATA_DIR at live account data.

Duplicate-design coverage verifies 13-16 merge into 1-4 while preserving player and bank holdings, earned counts, open sale listings, requested swap types, unchanged coins, historical trades and old request receipts. It also checks automatic same-design swap cancellation, repeat migration safety, and rollback when combined holdings would exceed the integer balance limit.

The market browser workflow opens sales from a gallery sticker, verifies its preselected type and five modal widths, checks Escape and Close without a transaction, opens bank purchases, and verifies successful sales close the dialog while uncertain results keep a retry available.
