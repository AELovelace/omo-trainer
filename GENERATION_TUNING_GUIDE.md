# Daily protocol and probability

The main mode starts at 50% on the first saved check-in, wetting, diaper change, or roll. A synced `kind: protocol` record fixes enrollment time, reporting timezone, and protocol version 1. Existing unclassified snapshots are preserved without inventing classifications or charging days before enrollment. Concurrent offline enrollments use the earliest timestamp, then ID as a tie-breaker.

Each actual wetting is a separate `kind: wetting` record with a timestamp, category, position, diaper number, and (for historical records only) an optional cumulative diaper wetting count. Categories are forced, semi-forced, voluntary, semi-involuntary, and involuntary. Semi-Forced (SF) is stored as `semi-forced` and appears between Forced and Voluntary in both classification menus. Repeated cumulative snapshots never count as classified events.

Observation and roll records are independent. `kind: observation` stores intake since the preceding saved check-in with `liquidsMode: interval` and diaper number; it has no probability or outcome. `kind: roll` stores the real draw time, computed probability, result and the position selected in the roll card, and takes no inputs from the observation form. Standalone roll metadata is not editable; individual draws can be deleted without clearing an active cooldown. Older observations retain any recorded position and wetting snapshot, and their edit form still exposes those historical fields. Legacy combined observations retain their original cumulative intake semantics. New wettings omit the diaper total. A separate `kind: diaper-change` stores the time, removed diaper's daily number and final `wettingsCount`; zero is valid for a dry change. Count changes by recorded local day, not by the highest diaper number. Change totals do not multiply classification counts or affect rolls. Older rolls may lack a position, and older wettings may lack a count. Those absent values remain absent when restoring or syncing.

Daily liquid totals add intervals by the check-in's recorded local date, including intervals spanning midnight. For mixed legacy/new days, use the maximum legacy cumulative amount plus interval amounts strictly after the latest legacy snapshot; earlier intervals are assumed already covered. The history and edit form distinguish interval amounts from cumulative amounts. Both CSV exports expose measurement mode (`liquidsMode` in device CSV, `liquids_mode` in administrator CSV); rolls, wettings and diaper changes have no intake. Existing SQLite version 2 JSON payload storage supports these record kinds without another table migration.

For every completed calendar day in the enrollment timezone:

- No recorded wettings: increase by 5 percentage points.
- Forced + Semi-Forced + Voluntary >= Semi-involuntary + Involuntary: decrease by 5 points.
- Otherwise: increase by 5 points.
- Clamp after each day to 20 through 80 inclusive.

lib/training.js derives the chance by replaying completed days. Empty days accrue while the app is closed. Today's events affect tomorrow; an earlier correction recalculates later days without rewriting saved roll probabilities. The About page explains the protocol and shows the latest 90 adjustment rows, but calculations include every day since enrollment. JSON and administrator exports include enrollment and all events for reproduction of this calculation. A missing day is missing data, not evidence that no wettings occurred.

A random Hold starts a ten-minute cooldown for random rolls. rolledAt and rolledResult preserve the actual draw time and original result separately from editable observation metadata. Backdating a check-in cannot shorten the cooldown, and changing its displayed result does not remove the original failure. The enrollment record also retains lastFailureAt, so deleting an individual failed observation does not remove the deadline. Saving observations and recording wettings remain available. Legacy random Hold records use their observation timestamp until expired.

This is an offline-capable, client-enforced protocol, not an anti-cheat system. Each device uses its clock and most recently synced records. Disconnected or concurrently used devices can have different knowledge; sync before switching devices. Correcting/deleting data may change derived probability. Deleting the whole dataset resets enrollment and its deadline. No browser implementation can enforce a shared offline lock against another disconnected device. Central SQLite stores the self-reported observations and draw metadata for analysis.

The generic RNG still supports 0-100 for legacy validation and mathematical tests. The main interface uses the calculated 20-80 chance and has no probability override. It uses rejection sampling with crypto.getRandomValues; retries upload the saved outcome without drawing again. Snapshot liquids, positions and counters do not directly change probability. Local settings now configure only the default position; the old probability preference remains readable for backup compatibility.

SQLite schema version 2 adds payload_json while retaining old typed columns and mutation receipts. New JSON records travel through the existing authenticated, participant-scoped sync queue, revisions and conflict resolution. Participant JSON backups retain envelope version 1 with new discriminated record kinds; old apps reject these kinds, so close old tabs and reopen the updated PWA before logging. Administrator exports use schema version 2 and include kind, category, original draw metadata, protocol version, timezone and liquid measurement mode.

Use the deployment updater's pre-activation backup when upgrading. A code rollback to an older build that only supports SQLite version 1 cannot open a migrated database. Preserve the migrated database and resolve the code issue or explicitly plan a restore; never silently replace it with an older backup and lose newer observations.

Run node --test tests/*.test.mjs and the browser workflows in TESTING_GUIDE.md after changes to these rules. Version future protocol changes explicitly so researchers can distinguish them.


## Promotional chart (2026-09-12)

The PWA's Potty chart is a separate star chart, linked to the same participant
file. Its stars and refusal counters do not affect Little Log probability,
classified wettings or cooldowns. Tune authored rows/praise in the game's
web/potty_chart/app.js and rebundle with scripts/import-growth-chart.mjs.
See GROWTH_CHART_GUIDE.md for bounded storage and sync behavior.

## Sticker economy tuning

Each eligible synced record draws uniformly from the full active sticker collection. The current bank rate is 10 plus distinct participating traders in the preceding 30 days, capped at 1,000 coins. Repeated trades by the same participant count once per type. All balances and prices are whole numbers. Chart stars also credit a separate balance, with no spending rate enabled. See ECONOMY_GUIDE.md for economic invariants; these rewards do not alter the training protocol.


## Additional event choices

Bedwetting and Used the potty are separate choices in Record a wetting and its edit dialog. Both retain their category through history, JSON/CSV and account sync. Used the potty does not increase the suggested diaper wetting total. Both count as recorded events for interval estimates, but have no F/SF/V/SI/I probability weight, ordinal action score or category performance bonus; a day with none of the original five categories follows the existing empty-day rule.


## Shared recording reward modal

Observation, wetting (including Bedwetting and Used the potty), and diaper-change saves now share the sticker modal. This changes presentation only: existing eligibility, one-sticker-per-record receipts, category bonuses and probability rules stay the same.


## Login bonuses and diamonds

Daily bonuses pay 10/20/30 coins on streak days 1/2/3, then streak minus 3 diamonds each day. A missed day resets the streak. Diamond exchange is fixed at 50 coins per diamond. These rewards are separate from classification performance bonuses and probability rules; see LOGIN_BONUSES_GUIDE.md.

## AI report prompt tuning

Admin console → AI analysis offers an editable report prompt, 1–31 day comparison window, model, temperature and output token limit. Save before queueing. Reports retain their settings and aggregate source statistics; prompt changes affect future jobs. This customizes inference instructions, not model weights. See [AI_ANALYSIS_GUIDE.md](AI_ANALYSIS_GUIDE.md).

## Starting coins

New Little Log accounts start with 50 lid0llcoins, credited once through registration. This grant is separate from record performance bonuses and daily streak rewards; it does not alter probability or grant stars/diamonds. See [ECONOMY_GUIDE.md](ECONOMY_GUIDE.md).
