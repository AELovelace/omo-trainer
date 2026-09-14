# Dialogue integration status

No NPC dialogue system or dialogue assets are present in this tracker. Current interface text lives in `index.html` and `app.js`; there are no character branches to synchronize with `game_editor_gui.py` yet.

Chrysalis presentation copy uses brief archival labels: observation, record archive, terminal, and identity gateway. The anonymous margin note in `index.html` is fictional interface flavor, not dialogue attributed to a game character. Keep this flavor outside factual status, consent, deletion, and error messages. Registration, sign-in, and consent copy live in `auth/views.mjs`; server validation feedback lives in `scripts/auth-server.mjs` and `auth/store.mjs`.

Confirm observations, rolls and actual wettings separately. A saved observation has no pee/hold result; a standalone roll records its selected position but no liquid intake or diaper snapshot. Wetting confirmations refer to one classified event even when its saved diaper total is greater than one. Describe new liquids as consumed since the previous check-in, and old cumulative measurements explicitly as legacy daily totals. Preserve clear error and recovery messages when updating the app's tone. Document actual NPC trees here only when the original game's source becomes available.

The daily protocol uses factual category labels and countdown/status messages in `index.html` and `app.js`. A classification records one actual event; a random result never creates one. Empty-day increases describe the absence of recorded events, not an inferred bodily outcome. Keep archive flavor separate from these distinctions.

Account/sync text must distinguish saved-on-device from saved-to-server and disclose organizer access to uploaded records. Avoid describing connected records as browser-only or visible exclusively to the participant.


## Growth Chart integration (2026-09-12)

The bundled promotional chart retains the authored praise, locked-row refusal
and friend-note reveal. These are chart content, not new NPC dialogue-tree
fields. Account status and conflict messages live in account.js outside the
fictional chart voice. Keep source and bundled assets synchronized using
scripts/import-growth-chart.mjs. See GROWTH_CHART_GUIDE.md.


## Additional event choices

Bedwetting and Used the potty are separate choices in Record a wetting and its edit dialog. Both retain their category through history, JSON/CSV and account sync. Used the potty does not increase the suggested diaper wetting total. Both count as recorded events for interval estimates, but have no F/SF/V/SI/I probability weight, ordinal action score or category performance bonus; a day with none of the original five categories follows the existing empty-day rule.


## Shared recording reward modal

Observation, wetting and diaper-change saves share the reward modal. Pending messages identify an Observation, Event or Diaper change saved on the device, while earned-sticker messages appear only after the server returns that record's receipt.


## Login bonuses and diamonds

The shared recording modal now announces a daily bonus only when the server returns the receipt attached to that exact save. Calendar and pending-reward copy are factual interface status, not NPC dialogue. See LOGIN_BONUSES_GUIDE.md.

## AI report status copy

The admin-only AI analysis panel distinguishes queued, running, completed, failed and cancelled jobs. Report text is model output for administrator review, not NPC dialogue. An explicitly authorized MommyBot integration can retrieve only completed nightly documents for Discord publication through [AI_REPORT_API.md](AI_REPORT_API.md). Manual runs stay in the console; the tracker does not itself send Discord messages.

## Welcome grant copy

The wallet records **Welcome bonus: 50 lid0llcoins** once for each newly created Little Log account. This is wallet history, not an NPC event or a daily check-in announcement.
