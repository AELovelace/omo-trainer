# Little Log user checklist

Little Log now appears as a recovered Chrysalis observation terminal. **Record archive** is your history view; **Settings & data** contains account and export controls. The **CRT FX** button toggles a static terminal texture and remembers the choice in this browser. Reduced-motion settings turn that texture off.

- Open `/tracker/` in your browser. Optional: install it from your browser menu, or Safari's Share → Add to Home Screen.
- In Settings, sign in with your shared lidoll.dev account to connect this device. Connecting uploads existing entries and future changes; the organizer can use synced records for analysis.
- You can also choose **Sign in to sync** beside the save status at the top of any page. After signing in, **Connect device** opens Settings so you can review and approve uploading this device's entries. The header button disappears once this device is connected and signed in.
- If you need an account, choose **Create account**, enter a username and a password twice, then review the app's identity access. Back in the tracker, choose **Connect & upload my entries** when ready to sync your local records.
- Check the time and enter liquids consumed since your previous saved check-in in mL. Choose **Save liquids** to record it; the intake field then resets to zero.
- Choose the check-in diaper number. Select **Your position** in the roll card before rolling. In **Record a wetting**, classify one actual event; its diaper number is assigned automatically from records at the event time.
- Use **Record a diaper change** below the wetting form to save each change and the number of wettings that diaper received. Correct the suggestion for unlogged or overnight wettings; 0 records a dry change. The next diaper number is suggested after saving.
- The main protocol starts at 50% with your first saved record. Use **Roll** in its own card to draw using the daily chance. It saves the roll and its selected position, leaving your unfinished observation alone. A Hold pauses further rolls for ten minutes; **Save liquids** and wetting logging stay available.
- In **Record a wetting**, classify each actual event once as Forced, Semi-Forced (SF), Voluntary, Semi-involuntary, Involuntary, Bedwetting, or Used the potty, including events without a roll. Each save adds one classified event. The per-diaper total is recorded separately when changing it.
- Completed days with F + SF + V >= SI + I reduce the chance by 5 percentage points. Other days, including days with no F/SF/V/SI/I events recorded, increase it by 5 points. The chance stays between 20% and 80%. Open **About** in the navigation to read the protocol rules and review your daily adjustment history.
- Today affects tomorrow. Correcting a past wetting recalculates later days; recorded roll probabilities stay unchanged. Day boundaries use the timezone saved at enrollment, even on another device.
- Use the bathroom whenever needed. The random result is optional and does not record a wetting automatically.
- Review Charts or History. Edit mistakes or delete individual records in History.
- Download JSON backups in Settings. Import restores new records without duplicating identical entries. CSV exports the current history selection for spreadsheets.
- Check the save status: offline changes wait on this device until it reconnects. Reopen the app and sign in again if the session expires. Use the same account on another device to retrieve your central history.
- If Settings reports a conflict, compare the device and server copies and explicitly choose which one to keep.
- Sign out & clear device removes this device's copy after ending Little Log's session. It preserves server records; export pending changes first. Shared sign-in can remain active for other lidoll.dev apps.
- Deleting entries while connected queues deletion from the central database and other devices. Older downloaded files or server backups may retain previous copies.

Diaper defaults reset when the selected local date changes, while unsaved intake stays in the form. Today's liquid summary adds interval amounts saved on that date. Older cumulative snapshots are counted once, with only later intervals added. If an interval spans midnight, its intake belongs to the check-in date. Historical timestamps retain their recorded local day and timezone offset.

Default position is device-specific; enrollment, wettings, diaper changes and check-in records sync. Sync before switching devices: an offline device cannot know about another device's pending records or cooldown. You can register yourself or use an account created by the lidoll.dev administrator. No email address is collected; contact the administrator for password resets.

During a server update, offline check-ins remain on the device and retry afterward. After a frontend update, close old Little Log tabs and reopen to let the new app version activate.


## Intake units

- [ ] Switch mL / US fl oz with a draft amount and confirm switching back preserves it.
- [ ] Enter decimal ounces, save, and verify history records the converted whole mL value.
- [ ] Reopen offline and confirm the unit preference remains selected and new intake starts at zero.

## Mobile quick actions

- [ ] Switch between Record liquids, Record wetting, Roll and Pattern analysis using the bottom bar.
- [ ] Enter a draft, switch away and return; confirm the form retains its values.
- [ ] Verify Back/Forward, offline reopening, and returning from Settings.
- [ ] Check form buttons and notifications remain reachable above the bar and phone home indicator.

## Linked Potty chart (2026-09-12)

- [ ] Open Potty chart from Little Log's navigation or installed-app shortcut.
- [ ] Sign in; confirm the browser chart links and uploads automatically.
- [ ] Check that its file ID matches your observation participant.
- [ ] On a fresh second device, confirm the saved chart loads automatically.
- [ ] Sign in with a different guest chart; confirm automatic merging retains both sets of row meanings and stars.
- [ ] Edit offline, reopen and reconnect; confirm automatic merging and retries complete without a version-choice prompt.
- [ ] Download a chart backup before clearing or replacing content you want to keep.
- [ ] Confirm switching accounts cannot upload the previous account's chart.
- [ ] Clear chart & reset rows, sync, and confirm cleared stars stay cleared.
- [ ] Sign out & clear this browser chart only removes this chart's local copy.

On mobile, use Record change in the bottom bar to save a completed diaper and its final wetting count. Switching tabs preserves your unsaved form.

Potty chart is a native Little Log view at #potty-chart. Navigation keeps the same document and preserves drafts; the app header shows chart sync status on this route. Existing ldq-growth-chart-v2 saves are reused. Old chart URLs and the PWA shortcut lead to the integrated view, and OAuth returns there. Run node scripts/embed-growth-chart.mjs after editing bundled chart markup/styles; the source importer also runs it. Commit index.html and potty_chart/embedded.css with the matching chart scripts and worker. Static deployments must include the updated nginx chart redirects.

Roll desperation: the four-step slider records low/medium/high/crisis on each new roll (displayed Low/Med/High/Crisis), without changing probability or cooldown. History, JSON/CSV backups, database sync and admin exports retain the field. Older rolls omit it and appear as Not recorded in the admin distribution. The chosen level stays selected while switching views and after saving; a new page starts at Low. Tests/desperation.test.mjs covers validation, sync and export round trips; tests/training-browser.mjs checks keyboard steps, saving and mobile draft retention.

## Stickers and market

- Connect your device in Settings so saved observations, wettings and diaper changes can earn account stickers. Offline records earn when they sync.
- Open Stickers & market to see each type owned, listed and earned, plus LiDollCoins and separate spendable stars.
- Sell to the stickerbank, buy from other users, list a coin sale or offer a sticker swap. Check the displayed whole-number total.
- Cancel your own listing to release its reserved stickers. Retry an unconfirmed exchange with Retry pending exchange.
- Chart progress remains intact; each dated row cell earns its separate star once. Star spending will arrive later.

## Choose your theme

Open Settings and choose **Little Tracker** for soft pastels or **Caregiver Tracker** for the original dark look. Little Tracker is the default. Changes apply immediately and save on this device; forms stay filled while you switch.

- Home reminders scroll horizontally; use Pause to stop them. Reduced-motion settings display the full text without scrolling.
- Administrators: open Admin console > Reminders, enter up to 500 characters, enable Show this reminder, then Save reminder. Turn Show off and save to hide it while retaining the text. Published reminders are visible to signed-out visitors too.

- Administrators: **Admin console > Reminders > Margin note** edits the home-page tips separately from the scrolling header. Enter up to 2,000 characters, keep line breaks if wanted, and save. Use **Show this margin note** to publish or hide it.

- **Settings > Manage connected games** lets you approve a LiDollQuest connection code or disconnect an app. A linked game earns/spends from the same LiDollCoin wallet; saved local gold is not deposited.


## Additional event choices

Bedwetting and Used the potty are separate choices in Record a wetting and its edit dialog. Both retain their category through history, JSON/CSV and account sync. Used the potty does not increase the suggested diaper wetting total. Both count as recorded events for interval estimates, but have no F/SF/V/SI/I probability weight, ordinal action score or category performance bonus; a day with none of the original five categories follows the existing empty-day rule.


## Shared recording reward modal

After saving an observation, a wetting or a diaper change, dismiss the reward modal to continue. Online synced saves show the earned sticker with the same sound and confetti preferences. Offline or signed-out saves show a pending message; reconnect and sync, then use the retry button to retrieve the sticker.


## Login bonuses and diamonds

Save and sync one observation, wetting or diaper change each day for a growing bonus. Visit Login bonuses in the menu for weekly/monthly calendars and daily statistics. Use Stickers & market to exchange diamonds for coins at 1:50. Offline saves qualify on their sync day; see LOGIN_BONUSES_GUIDE.md for streak rules.
