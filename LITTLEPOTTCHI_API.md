# Littlepottchi care and Little Log bridge

Littlepottchi keeps wetness, needs, outfits and timers in `data/clothes-gacha.db`.
It shares Diaper Atelier ownership and the existing LiD0llID account. Food, water,
activities and dressing are free; baby wipes are purchased care supplies. Replacing a diaper, including
the same design, supplies a fresh one; Cloud Tapes is also a free starter supply.

## Simulation

- **Adult character:** the doll is an adult of the player's chosen gender.
  Gender is optional text (up to 32 characters), separate from body shape, and
  does not change care rules, clothes or toy availability.
  `player.anatomy` stores independent `chest`, `nipples`, `genitals` and `pubes`
  catalog IDs. Old saves default to base chest/detail, no added anatomy and no
  pubic hair; the bare camera now follows anatomy rather than body shape.
  Appearance updates may include a partial `anatomy` object. Unknown IDs and
  keys are rejected; omitting it preserves existing choices. The browser splits
  hairstyle and color into controls but continues saving the validated `hair`
  image ID. Snapshots include server-resolved `bodyLayers` beneath clothing.
  Draft and unclothed previews are local only, with no care or inventory effects.
- **Excitement:** a saved 0–255 stat, initially zero, increases by 12 per hour.
  The toy menu offers reusable Pocket toy (1 minute, 85 relief), Wand (2 minutes,
  170 relief), and Dual-mode toy (3 minutes, 255 relief), all free. One toy runs
  at a time. Relief accrues over elapsed time and buildup pauses during a session;
  after completion, buildup resumes from the completion time, including offline.
  Stop retains only earned relief. Completion adds one care moment, once.
  Toys do not change accident schedules or cleanup requirements.
  Tune `src/dressup/excitement.js`; in-progress sessions retain their saved rules.

- **Remove diaper** deliberately switches to diaper-free care and its bare camera.
  Accident clocks keep running. Diaper-free wettings/messes and leaks set a saved
  cleanup requirement. Both **Fresh change** and equipping a diaper are blocked
  until the doll is wiped. Contained accidents can be changed without a wipe.
  One wipe clears all accumulated body wettings/messes, without resetting either
  clock or emptying the currently worn diaper. Removing clothing or toggling messy
  mode never clears body cleanup. A later accident can require another wipe.
- **Buttcams:** frame 1 is clean; subsequent numbered frames represent messy
  accidents, capped at the last supplied frame. Wettings keep the clean frame.
  Turning messy mode off forces clean camera art even if an earlier mess remains.
  All 58 designs have a camera: 43 direct family mappings and 15 labeled generic
  fallbacks, following lidollquest's LargeDiaper1 fallback. The Slime sequence has
  only a clean frame. Bare body variants are anatomy alternatives, not mess stages.
  Camera PNGs are served only by authenticated `/littlepottchi/api/buttcam`; the
  server chooses the current frame and ignores client frame parameters. They are
  excluded from the public artwork allowlist. `buttcam` metadata is in pet snapshots.

- Each wetting adds **1 wetness**. At `wetness + (mess × 2) >= diaper.bulk`, the doll leaks until
  a fresh diaper is equipped or selected with **Fresh change**. Only diapers and
  training pants may fill this slot; ordinary underwear is unavailable. Removing clothing, changing appearance, selling an item or
  refreshing does not clean the doll. Replacements preserve the next wetting time.
- **Messy mode** is optional and off for new and migrated saves. While enabled,
  each messy accident is scheduled after a randomly chosen 10–14 hours; each uses two bulk units.
  The first interval and every subsequent interval are sampled independently.
  Saved deadlines, including existing 12-hour countdowns, survive updates, restarts
  and diaper changes. Offline catch-up samples each elapsed interval separately.
  Little Log's saved analysis currently has no bowel-event counts, so this timer
  is explicitly authored game timing and does not use the community wetting mean.
  The doll displays wet and messy counts separately, with one combined capacity
  meter. A messy diaper reduces comfort and needs a fresh change even before it leaks.
  Disabling the mode pauses its remaining time without clearing mess or leaks;
  enabling resumes it. Repeated settings requests do not restart the timer.
  Fresh replacements clear both counts while preserving both accident clocks and
  lifetime totals. Offline accidents catch up once, without a notification storm.
  Tune `messyRules` in `src/dressup/care.js` (`minInterval`, `maxInterval` and bulk per accident).
- Bulk is an integer from 1–100, independently editable from the diaper's visual
  stance in `python/game_editor_gui.py`. The initial values are authored for this
  game, using lidollquest's bulk concept: Small 2, Medium 3, Large 4, Huge 5,
  Giant 6, Moosive 8, Waddle 10, Training/Covers 1, other designs 3.
  They are game wetting units, not measured fluid volumes or exact imported RPG stats.
- The rhythm is **sum of recorded wettings / sum of active participant-days** in
  the latest completed community AI report's saved input. Potty use is included;
  random roll results are excluded. This is a derived count rate, not measured
  within-day intervals. The interval is `24 hours / rate`, limited to 30 minutes
  through 24 hours for playability. A recorded zero rate pauses wettings. Until a
  usable report arrives, the UI explicitly labels its four-hour default rhythm.
  Reports with no active participant-days leave the previous usable rhythm in place.
- New reports affect future timing. Replays are idempotent; older completed
  reports cannot replace a newer profile. No names or individual records reach
  the pet client. The community source includes disabled accounts because that
  is the scope of Little Log's saved analysis.
- Food is due every 4 hours, water every 2, play every 3, rest every 8. Play takes
  2 minutes and rest takes 5. One activity runs at a time; completion rewards are
  applied once, including offline completion. Food/water have 30-second cooldowns.
  Pantry artwork comes from `Figures/Items/Collectibles`; water uses a text control.
- Needs decay without killing the doll or deleting collectibles. The server
  advances 100 saved dolls every 30 seconds, cycling through all accounts. Reads
  and actions catch up immediately. Browser care snapshots refresh every 15 seconds.

## Server configuration

`BABYWIPES_PRICE=1` sets the whole-coin price per wipe (1–10,000, default 1).
Changing it affects new purchases only. Supplies remain available if only clothing
rolls are paused; the Atelier enable setting controls new supply purchases.

### Baby wipe purchase and use

Buy one wipe from `/diapers/#supplies`. Authenticated POST `/diapers/api/supplies`
accepts `{"action":"buy","request":"<stable UUID>","amount":1}` with the shared
session cookie, same-origin header and CSRF token. POST `{"action":"retry"}`
resumes a pending wipe payment. After response uncertainty, reuse the original
purchase UUID; browser storage preserves it across reloads. A definitive rejection
returns `retryable:false`. No wallet token reaches the browser.

Payments use the clothing journal and its shared wallet lock; `/lidollid wallet
retry` can recover them. Delivery increments `care_supplies.wipes` atomically with
the paid job's completion. Wipes cannot be rolled, sold, banked or equipped.
Pet snapshots expose `supplies` and body cleanup fields `needsWipe`, `bodyWetness`,
`bodyMess`. POST `{"action":"wipe"}` to `/littlepottchi/api/doll` consumes exactly
one delivered wipe and clears all body cleanup in the same SQLite transaction.
A clean doll cannot waste a wipe. `{"action":"equip","slot":"diaper","design":null}`
removes the diaper; `player.diaperFree` remembers that choice across restarts.

### Little Log connection

Set the **same new random secret** (32–512 non-whitespace characters) on both hosts:

```dotenv
LITTLEPOTTCHI_BRIDGE_TOKEN=<new dedicated random secret>
```

On Little Log also set:

```dotenv
LITTLEPOTTCHI_API_URL=https://bot.lidoll.dev/littlepottchi/integration/v1/
```

For the home LAN, set this on **Little Log** to bypass hairpin NAT:

```dotenv
LITTLEPOTTCHI_API_URL=http://10.1.1.23:4190/littlepottchi/integration/v1/
```

This address is only for server-to-server analysis uploads, event polling and
acknowledgements. Game links, notification links, `LIDOLLID_PUBLIC_ORIGIN`, the
LiD0llID issuer and browser sign-in callbacks keep their working public URLs.
MommyBot's existing `LIDOLLID_HOST=10.1.1.23` and `LIDOLLID_PORT=4190` already
provide the correct listener; keep those settings and the working reverse proxy.
Allow the Little Log server to reach that port through the host firewall.
Use the direct listener; a proxy that redirects to the public hostname would
reintroduce hairpin NAT and is rejected by the bridge.

The URL accepts HTTPS, or HTTP on a configured private IPv4 address (10/8,
172.16/12, 192.168/16) or loopback. Use plain HTTP only on the trusted LAN.
The bridge never follows redirects with its bearer credential. Existing report-read
credentials are not accepted and their permissions do not change. No credentials
are sent to the browser. With these variables unset, the bridge is disabled.
Restart both services after configuring their environment; do not put secrets in Git.

Little Log's existing notification tick calls `createLittlepottchiBridge` once per
minute. It uploads only the latest completed job's saved `input.days` counts,
then polls pet events. Analysis synchronization also works without push keys.
Push delivery additionally needs Little Log's existing VAPID configuration and
an active browser subscription. `database.notifications.littlepottchi.status()`
reports configuration and a generic last synchronization error without secrets.

Players opt in using **Receive pet reminders through Little Log** in Littlepottchi
and enable push in Little Log using the same LiD0llID account. Disabling the pet
checkbox cancels queued reminders. Quiet hours, disabled accounts and removal of
Little Log subscriptions are respected. Notification clicks open Little Log's
Games page, which links to Littlepottchi and Clothes Emporium.

## API v1

The authenticated browser endpoint `/littlepottchi/api/doll` accepts
`{"action":"toy","toy":"pocket"}` (also `wand` or `dual`) and
`{"action":"stop-toy"}` with the existing session, Origin and CSRF checks.
Only the server chooses duration and relief. Activating the same running toy
preserves its deadline; switching requires stopping first. Zero-level starts
are rejected. Snapshots expose `excitementRules`, `player.excitement`,
`player.care.toy` and `player.care.completedToy`. Appearance updates may include
`gender`; older clients that omit it preserve the saved value. These browser
actions are separate from the bearer-authenticated bridge paths below.

All paths below are relative to `/littlepottchi/integration/v1/` and require
`Authorization: Bearer <LITTLEPOTTCHI_BRIDGE_TOKEN>`. POST bodies require
`Content-Type: application/json`. Browser cookies and CSRF tokens do not authorize
these endpoints. Responses are never cached. Maximum request size: 256 KiB.

### POST `analysis`

```json
{"reportId":"report-example","finished":1789473600000,"days":[
  {"date":"2026-09-14","wettings":18,"activeParticipants":3}
]}
```

`finished` is the completed report's Unix timestamp in milliseconds. Use the exact
saved report counts, not live records or AI prose. The server accepts 1–3,660 unique
dated rows, nonnegative integer counts, and a positive total participant-day count.
Returns `{ "accepted": true }`, optionally `unchanged:true`; a stale report returns
`{ "accepted": false, "stale": true }`. An altered replay is rejected.

### GET `events?after=0&limit=50`

Returns `{events, nextAfter, more}`. Limit: 1–100. Each event has a stable UUID
`id`, integer `sequence`, `recipient:{issuer,subject}`, `kind`, fixed `title/body`,
and millisecond `created/expires`. Kinds: `wet`, `mess`, `leak`, `cleanup`, `feed`, `water`, `play`,
`rest`, `complete`. Events expire after 24 hours. Follow `nextAfter` while `more`
is true, even if a page has no events; begin a later polling pass at zero to revisit
unacknowledged events deferred by quiet hours. Do not treat a cursor as a receipt.

The feed checks current need, opt-in and the original verified identity binding.
Wet reminders coalesce within a diaper change; each leak or due-care episode is
reported once. Old offline wettings do not produce a notification storm.
Messy reminders also coalesce per diaper. Cleanup takes priority over a leak; a leak takes priority over mess, and
mess takes priority over wetness. A fresh change invalidates all three old needs.

The existing authenticated browser action endpoint `/littlepottchi/api/doll`
accepts `{"action":"messy-mode","enabled":true}` (or false) with its usual
session, same-origin and CSRF checks. Pet snapshots expose `messyRules`, `usedBulk`
and `player.care.{messyMode,mess,messings,nextMessAt,messRemaining}`; `mess` counts
accidents in the current diaper, while `messings` is the lifetime total.

### POST `events/ack`

```json
{"ids":["d5b2c7fe-30cd-4491-a499-e2f1222c09bd"]}
```

Accepts at most 100 event IDs; repeated receipts are safe. Returns `{ok:true}`.
Little Log journals each endpoint before attempting a push and acknowledges only
after processing it. An uncertain push is not retried, preventing duplicate pushes
at the cost of possible missed delivery. Lost API acknowledgements are safe to retry.
At most 10 push attempts occur per tick. No subscribers means the event is skipped.

## Source installation and verification

`integrations/little-log/littlepottchi-bridge.mjs` is the maintained bridge source.
The corresponding installed module belongs in Little Log's `server/` directory.
`python/stage_little_log_bridge.py` stages the sibling changes under ignored
`data/little-log-pet-patch/`; `ps/install-little-log-pet-bridge.ps1` verifies every
original SHA-256 before copying. These are one-time integration helpers and do not
deploy or restart services. Later changes should be made against the current files.

Tests use memory databases, synthetic AI snapshots, fake wallet balances and fake
push transports. Run `npm test` here and `npm test` in Little Log. Browser checks:
`node scripts/check-dressup-browser.mjs` with the documented local Chrome settings.
