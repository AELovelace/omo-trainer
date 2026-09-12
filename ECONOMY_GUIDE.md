# Stickers, stars and LiDollCoins

The gallery and market live at /tracker/#stickers in the main app. A synced observation, wetting or diaper change earns one uniformly random sticker from the full active collection, using the server's cryptographic random-number generator. Rolls do not earn stickers. The gallery at the bottom shows only types you currently own, including stickers reserved in your open listings. Each card tracks available quantity, reserved quantity, lifetime earned quantity, the current bank price and bank stock. The exchange selectors still include the full catalog so you can buy types you do not yet own.

The active collection is the 16 numbered images in sprites/. Nested folders are supported; _originals and hidden files are excluded so backup copies never become reward types. PNG, WebP, JPEG and GIF are supported. Restart the service after changes. File paths determine stable sticker IDs: do not rename published assets. Retired files keep their old inventories and trading identities. Missing assets leave earned stickers pending; opening the gallery or recording again resolves pending awards after the collection is installed. Images are lazy loaded online; the PWA caches the gallery shell but never caches wallet APIs. Trading requires an online account session.

## Two separate databases

- DATA_DIR/little-log.sqlite contains participants, scientific records, charts, sessions, admin access controls and reward_outbox entitlements.
- DATA_DIR/market.sqlite contains sticker types, wallets, inventory, reward receipts, star receipts, listings, trades, ledger entries and exchange request receipts. It has no observations, chart documents, labels, account credentials or scientific export tables.

The market receives opaque participant IDs and hashed reward source IDs. Scientific record kinds and chart row meanings stay in the scientific database. Each scientific save writes its entitlement in the same scientific transaction. After commit, the bridge delivers entitlements to the market in a separate transaction, then acknowledges delivery. A crash between those commits safely replays against unique market receipts. Market write failures leave scientific saving available. A 30-second server timer retries pending delivery; sync and gallery visits also retry. Batches are limited to 1,000 entitlements.

Existing and imported typed records are backfilled by stable ID when their owner opens the collection. Importing the same IDs, editing an entry, restoring its tombstone or replaying sync does not produce a second reward. Importing genuinely different IDs counts as new records. Scientific CSV/JSON imports and exports do not contain or replace market balances. Deleting a scientific record does not revoke an already-earned sticker.

Each dated chart row cell earns one separate spendable star for its lifetime. Removing and restoring that same cell never earns twice. Spendable stars do not change chart progress; no star spending or conversion rate is enabled yet. The market stores hashed cell receipts, not row names or chart contents.

## Pricing and exchanges

Bank price per sticker = 10 + min(990, distinct participants trading that sticker during the previous 30 days). Count completed trades only. Bank trades count their participant; participant trades count both participants; a swap counts activity for both types. The bank itself never counts as a participant. One person counts once per type regardless of trade frequency. Expired activity drops out when the next quote is read. Prices range from 10 to 1,000 whole LiDollCoins.

Bank exchanges require the displayed unit price to still match at commit; changed prices are rejected for review. Peer listings use the seller's fixed total price or requested sticker bundle. A listing reserves the offered inventory immediately. Accepting transfers both sides atomically; cancellation returns the reserved stickers. There are no partial fills or self-trades. Up to 100 open listings are allowed per account; the gallery shows 500 recent available listings plus all of the owner's listings. Disabled users cannot trade, and their offers are hidden until access is restored.

The bank starts with no stock. Purchases from participants add to its inventory; bank sales deduct stock. When the bank lacks enough coins to buy stickers, it issues the shortfall into its own wallet and records that issuance in the ledger before paying the seller. Payments from users remain in the bank wallet. The gallery shows bank stock, its coin balance and total issuance.

Quantities and balances are integers. A single order offers 1 to 10,000 stickers; an account's coin, star or individual sticker balance is bounded at 2,147,483,647. Listing prices and requested swap quantities have the same integer upper bound. Total lifetime bank issuance is bounded by JavaScript's maximum safe integer. Every adjustment writes an immutable application ledger row. Direct database edits bypass these invariants and should not be used to award currency.

The browser saves an exchange request ID and exact body in session storage before sending. An uncertain result leaves a Retry pending exchange button, which reuses that request even after a reload. Successful and rejected operations refresh current balances. The backend never accepts an owner ID from the request body, rejects reused IDs with changed contents, and checks Origin, CSRF and the account session.

## Backup and recovery

Use the existing tracker service environment when running these commands. Both destinations must be new files outside the public directory:

    node scripts/admin.mjs backup /private/backups/science.sqlite
    node scripts/admin.mjs backup-market /private/backups/market.sqlite

The original backup command remains a scientific-only SQLite backup. The new command backs up only the market database, including its ledger, bank stock and receipts. For a coordinated recovery point, stop all tracker writers before taking both backups. The Fedora deployer's existing stopped-service directory backup includes both databases and their WAL files. Protect both backups; the market still contains account-linked economic activity.

Restore matched backups while the tracker service is stopped. Restoring an old market database alone can lose trades and previously delivered rewards; restoring scientific exports never restores currency. If an operator deliberately restores only a market snapshot, they must reconcile its lost market activity before replaying entitlements. Preserve the current files first. No destructive recovery or currency import is exposed in the browser.

## Verification

Run npm test for unit/API coverage. tests/economy.test.mjs covers reward idempotency, imports, stars, bank supply/stock, demand expiry, escrow, insufficient funds, swaps, authorization, database separation, market outages and replay after a simulated cross-database crash. tests/economy-browser.mjs uses disposable accounts and the actual sprite collection to check real gallery rendering, mobile widths, peer purchases, lost-response retry through reload and shared sign-out.
