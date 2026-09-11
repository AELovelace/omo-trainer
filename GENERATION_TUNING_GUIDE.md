# Probability and defaults

The Chrysalis observation theme changes presentation only. Archive labels, the terminal seal, and the CRT display preference do not affect roll probabilities, recorded values, or aggregation.

The probability is the integer percentage chance of a **pee** result. It accepts all values from 0 through 100 inclusive. Zero always yields hold; 100 always yields pee. The other probabilities use `crypto.getRandomValues` with rejection sampling over 100 equally likely outcomes. Every roll is independent; the app does not increase difficulty, create streak penalties, or learn from records.

Set initial preferences in `DEFAULT_SETTINGS` in `lib/model.js`; each person can override them in Settings. Per-entry controls can override those defaults. Liquids, position, diaper number, and wetting count do not affect probability. A manual result records the selected result and probability without generating randomness.

Probability results are generated once on the device and stored with each entry. Sync retries must upload the stored result without rerolling. Defaults stay per device; saved per-entry probabilities and results are included in central analysis exports. The server validates probabilities using the same shared model code as the browser.

The 1,000,000 mL and 10,000 counter limits are technical bounds for data validation, not real-world recommendations. Changing them requires matching HTML controls and validation. Changing the schema requires migration and import compatibility work. Run `node --test tests/model.test.mjs` after any change to roll behavior or aggregation.
