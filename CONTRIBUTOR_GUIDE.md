# Contributor guide

This repository currently contains a standalone browser tracker, not the original game.

- `index.html` and `styles.css`: accessible forms and responsive dashboard.
- The desktop dashboard groups observation and wetting forms in `.left-column`; rolling, charts and recent records use `.right-column`. Both columns stack at the existing narrow-screen breakpoint.
- `#about` in `index.html`, routed by `navigate()` in `app.js`, contains the protocol explanation and daily adjustment history. The tracker keeps the live roll probability and cooldown beside its controls.
- `lib/model.js`: schema validation, timestamps, probability, summaries, import, CSV.
- New `kind: observation` records use `liquidsMode: interval` and carry no roll outcome; standalone `kind: roll` records contain draw metadata and selected position. New check-ins omit position and wetting count; wetting events own the count. Keep those optional historical fields when validating older records. Keep their UI actions, validation, exports and summary contributions separate. Untyped legacy records retain cumulative intake semantics.
- `lib/training.js`: enrollment, stable reporting timezone, completed-day adjustments and original-draw cooldowns; see GENERATION_TUNING_GUIDE.md for rules and migration limits.
- `app.js`: controls, charts, local persistence, durable sync, conflict review, and account connection.
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

The Chrysalis theme follows the live lidoll.dev palette: page `#1a0611`, panel `#370f2d`, pink `#ff96c8`, pale rail `#fadadd`, and orchid `#a474d6`. `styles.css` holds the local font stacks and chart colors; SVG charts consume those same CSS variables. The archive seal, redactions, and margin note are presentation, not access-control or sync indicators. Keep actual save status, organizer access, errors, and account consent explicit. The shared identity views in `auth/views.mjs` use the same palette without external styles or fonts.

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
