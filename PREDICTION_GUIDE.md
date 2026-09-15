# Personal potty predictions

Little Log's **Pattern analysis** panel now includes a personal next-wetting estimate. On mobile, choose **Pattern analysis** in the bottom navigation. The model updates when observations or wettings are saved, edited, imported, deleted or synced; the conditional forecast updates each minute and on returning to the app.

The target is the next **recorded wetting**, including every classification. It does not measure the onset of an urge, bladder fullness, urine volume, or physiological absorption. Planned/forced events and missing logs affect its interpretation. A roll result and a diaper-change count are not observed wetting events.

## Inputs and scope

- Only the current profile's records are used. Existing participant-scoped scientific storage and sync remain the source of truth. No data go to external model services or the market database.
- Models are derived locally, including offline. Coefficients are kept in memory rather than duplicated in the database. Reopening the app rebuilds them from the user's records; corrections and deletions cannot leave an old persisted model behind.
- Use the last 90 days, at most 360 completed intervals. Absolute timestamps respect saved offsets. Ignore future records until their time arrives; deduplicate IDs. Exclude intervals under 5 minutes or over 8 hours as ambiguous/unsupported. These thresholds are engineering limits, not definitions of how often you should use your diaper.
- Modern check-ins contain **mL since the previous check-in**, not exact drink times. Assume a uniform spread over that interval only when its start is known and it is no longer than six hours. The first positive check-in, long/zero-duration reporting gaps, and old cumulative snapshots do not become timed fluid inputs. These exclusions are shown in the card. Total recent logged intake is still displayed, with clear wording that it is logged intake.

## Model

Version 1 is a regularized discrete-time survival model. For each completed interval, make 15-minute at-risk bins ending with an observed event. Features are elapsed minutes (scaled and capped), log elapsed time, and an optional decaying fluid-response proxy. Each row can use only intake reports available at that row's start; a later check-in cannot leak into an earlier prediction.

The proxy spreads each check-in amount across its reporting interval, then decays it exponentially after the check-in. Candidate response half-lives are **30, 60 and 120 minutes**. These are modeling assumptions to compare, not claimed biological absorption averages. They combine the association between drink timing, fluid processing and recorded behavior. The feature is scaled per 500 mL and capped at 4 to bound numerical influence, rather than treating extreme imports as unlimited certainty. Nonnegative coefficients prevent more elapsed time or additional fluid from reducing the fitted next-bin hazard.

Start interval-only estimates after 8 usable intervals across 3 recorded days. After 30 intervals across 7 days, reserve the latest 25% of intervals for chronological validation. With 20 timed positive intake reports and sufficient variation, compare each fluid model against the timing baseline using next-bin **Brier score**. Select a fluid adjustment only if it improves validation by at least 5%; refit the selected model on the available history. This is a development validation set used for model selection, not an independent clinical evaluation. Sparse/weak data correctly retain the timing-only model.

From the current elapsed time, calculate a conditional event distribution over the next 8 hours, using known drinks only. Future drinks are never assumed. Display the central 60% model window, most likely 15-minute bin, next-hour probability, and half-hour probability bars for the next six hours with an accessible table. Probabilities are model estimates and have not been clinically calibrated. Limited/Moderate evidence describes diary coverage, not medical reliability; Moderate requires 60 intervals and 14 recorded days. After 8 hours without a new wetting record the estimate pauses instead of resetting a countdown.

## Limits and use

Use your diaper whenever you need; do not wait for the estimate or adjust drinking to satisfy it. Logging gaps, sleep, activity, medicines, unrecorded toilet visits and differences between leakage and complete voiding are not measured. The model cannot infer their effects from drink amounts alone. There are no reminders to hold, drink more, or drink less, and the random-roll protocol is unchanged.

NIDDK recommends recording what, when and how much a person drinks alongside urination in a bladder diary: https://www.niddk.nih.gov/health-information/urologic-diseases/bladder-control-problems/diagnosis . Urine production and frequency also depend on fluid loss and bladder capacity: https://www.niddk.nih.gov/health-information/urologic-diseases/urinary-tract-how-it-works . Those sources support the input choices and limitations; they do not validate this algorithm or its half-life candidates.

## Maintenance and deployment

- `lib/prediction.js`: deterministic record preparation, training, chronological comparison and forecast.
- `lib/prediction-view.js`: account-aware training cache and minute-by-minute presentation.
- `app.js` / `index.html` / `styles.css`: automatic updates and the mobile Analysis card.
- `sw.js`: v40 caches both prediction modules for offline use. `scripts/serve.mjs` allows their public URLs.
- Deploy the updated app and both new modules together. No scientific or market database migration is needed. Existing PWA installations receive the new service worker using their usual update flow.

Run `npm.cmd test` for model and existing app/server tests. Run `node tests/prediction-browser.mjs` for mobile layouts, real form saves, empty/reset histories and offline prediction with synthetic records. The browser test supports `PUPPETEER_MODULE` and `CHROME_PATH` and uses an isolated temporary database. Never tune or benchmark against another user's records without their authorized data access.

## Admin participant predictions

In Admin, open **Predictions** and select one participant, or choose **Prediction** from their User management row. The shared renderer uses the same personal model and probability chart as Little Log. It reads the selected user through the existing admin-authorized data endpoint, independently of analysis date filters. Records refresh every 30 seconds while the panel is visible, and **Refresh estimate** fetches immediately. Unsynced device records are unavailable to the admin; timestamps use the admin browser timezone. Everyone shows a selection prompt instead of pooling users into a model.

All model inputs remain in memory. Switching participants, leaving the panel or losing authorization clears the rendered estimate and training cache; late responses cannot replace another participant?s view. No extra database migration or storage is added. The admin renderer bypasses older installed PWA shell caches, and shell v41 includes the shared module update. Run `node tests/admin-prediction-browser.mjs` to verify user drilldown, fresh data, selection races, empty histories, mobile layout, session revocation and ordinary-user denial with isolated synthetic accounts.
