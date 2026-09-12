# Testing guide

## Automated regression tests

```sh
node --test tests/*.test.mjs
```

These cover all 101 probability settings, rejection sampling, cumulative snapshots, calendar boundaries, schema/import validation, CSV fields, SQLite persistence and backups, participant isolation, idempotent retries, transaction rollback, version conflicts, deletion tombstones, app sessions, password hashing/reset/disable, OIDC adapter persistence, and login throttling. HTTP checks verify public assets, redirects, headers, and rejection of unauthenticated or cross-origin data access. Databases use isolated directories under ignored `artifacts/`.

`tests/training.test.mjs` covers daily ties, empty days, both bounds and movement away from them, completed-day-only adjustments, legacy snapshots, DST/timezones, deterministic enrollment selection, cooldown boundaries, original results surviving corrections, typed event backups/exports, multi-device synchronization, and migration from SQLite version 1 without losing records or retry receipts.

`tests/observations.test.mjs` verifies interval sums, overlapping legacy cumulative snapshots, date attribution, separation of draw and observation fields, measurement-mode validation/exports, retry idempotency, second-device synchronization and totals after edits/deletions. The browser workflow verifies observation editing and intake reset; the protocol browser workflow checks that rolling preserves an unfinished observation and that saving during cooldown never creates another roll.

Relocated-field coverage verifies that roll position and wetting diaper totals survive SQLite, exports and second-device sync; older observation fields remain intact. Browser checks select a roll position, save a wetting total, verify its next suggested count and edit the saved total without multiplying daily category counts.

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
