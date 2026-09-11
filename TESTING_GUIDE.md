# Testing guide

## Automated regression tests

```sh
node --test tests/*.test.mjs
```

These cover all 101 probability settings, rejection sampling, cumulative snapshots, calendar boundaries, schema/import validation, CSV fields, SQLite persistence and backups, participant isolation, idempotent retries, transaction rollback, version conflicts, deletion tombstones, app sessions, password hashing/reset/disable, OIDC adapter persistence, and login throttling. HTTP checks verify public assets, redirects, headers, and rejection of unauthenticated or cross-origin data access. Databases use isolated directories under ignored `artifacts/`.

## Browser workflows

Start `node scripts/serve.mjs` in another terminal. The optional browser runner uses Puppeteer with an installed Chrome/Chromium. Install the testing dependency with `npm install --no-save --package-lock=false puppeteer-core`, or set `PUPPETEER_MODULE` to an existing Puppeteer module file. Set `CHROME_PATH` to the browser executable and run:

```sh
node tests/browser.mjs
```

`TEST_URL` defaults to `http://127.0.0.1:4173/tracker/`. The runner uses an isolated browser context and synthetic data, so it does not access normal Chrome-profile records. It writes screenshots and test-only backup files to ignored `artifacts/`.

The workflow covers random/manual logging, daily carry-forward/reset, independent wetting counts, persistence after reload, charts, filters, editing, JSON/CSV downloads, valid and invalid imports, preferences, offline reload and saving, 390px phone layout, deletion, quota errors, and corrupt-data recovery. Screenshot fixtures are synthetic; the application ships with an empty history.

## Connected browser and shared-auth workflows

With the same Puppeteer and CHROME_PATH configuration, run:

```sh
node tests/connected-browser.mjs
```

This runner starts its own isolated tracker and identity services on ports 43173 and 43180, creates synthetic Alice/Bob accounts, and stops only its own processes afterward. It exercises the full OIDC authorization-code/PKCE login and consent flow, migration of local entries, HttpOnly cookies and CSRF checks, another device restoring the same account, offline reload and reconnect, participant isolation, conflicting edits, central analysis export, sign-out, and narrow-screen settings. A separate registered future-app client verifies shared sign-on with the same stable subject and rejects authorization-code replay.

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
