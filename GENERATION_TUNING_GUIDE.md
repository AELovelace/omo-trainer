# Daily protocol and probability

The main mode starts at 50% on the first new observation. A synced `kind: protocol` record fixes enrollment time, reporting timezone, and protocol version 1. Existing unclassified snapshots are preserved without inventing classifications or charging days before enrollment. Concurrent offline enrollments use the earliest timestamp, then ID as a tie-breaker.

Each actual wetting is a separate `kind: wetting` record with a timestamp, category, position, and diaper number. Categories are forced, voluntary, semi-involuntary, and involuntary. Repeated cumulative snapshots never count as classified events.

For every completed calendar day in the enrollment timezone:

- No recorded wettings: increase by 5 percentage points.
- Forced + Voluntary >= Semi-involuntary + Involuntary: decrease by 5 points.
- Otherwise: increase by 5 points.
- Clamp after each day to 20 through 80 inclusive.

lib/training.js derives the chance by replaying completed days. Empty days accrue while the app is closed. Today's events affect tomorrow; an earlier correction recalculates later days without rewriting saved roll probabilities. The interface shows the latest 90 adjustment rows, but calculations include every day since enrollment. JSON and administrator exports include enrollment and all events for reproduction of this calculation. A missing day is missing data, not evidence that no wettings occurred.

A random Hold starts a ten-minute cooldown for random rolls. rolledAt and rolledResult preserve the actual draw time and original result separately from editable observation metadata. Backdating a check-in cannot shorten the cooldown, and changing its displayed result does not remove the original failure. The enrollment record also retains lastFailureAt, so deleting an individual failed observation does not remove the deadline. Manual logging and recording wettings remain available. Legacy random Hold records use their observation timestamp until expired.

This is an offline-capable, client-enforced protocol, not an anti-cheat system. Each device uses its clock and most recently synced records. Disconnected or concurrently used devices can have different knowledge; sync before switching devices. Correcting/deleting data may change derived probability. Deleting the whole dataset resets enrollment and its deadline. No browser implementation can enforce a shared offline lock against another disconnected device. Central SQLite stores the self-reported observations and draw metadata for analysis.

The generic RNG still supports 0-100 for legacy validation and mathematical tests. The main interface uses the calculated 20-80 chance and has no probability override. It uses rejection sampling with crypto.getRandomValues; retries upload the saved outcome without drawing again. Snapshot liquids, positions and counters do not directly change probability. Local settings now configure only the default position; the old probability preference remains readable for backup compatibility.

SQLite schema version 2 adds payload_json while retaining old typed columns and mutation receipts. New JSON records travel through the existing authenticated, participant-scoped sync queue, revisions and conflict resolution. Participant JSON backups retain envelope version 1 with new discriminated record kinds; old apps reject these kinds, so close old tabs and reopen the updated PWA before logging. Administrator exports use schema version 2 and include kind, category, original draw metadata, protocol version and timezone.

Use the deployment updater's pre-activation backup when upgrading. A code rollback to an older build that only supports SQLite version 1 cannot open a migrated database. Preserve the migrated database and resolve the code issue or explicitly plan a restore; never silently replace it with an older backup and lose newer observations.

Run node --test tests/*.test.mjs and the browser workflows in TESTING_GUIDE.md after changes to these rules. Version future protocol changes explicitly so researchers can distinguish them.
