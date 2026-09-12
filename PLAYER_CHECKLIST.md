# Little Log user checklist

Little Log now appears as a recovered Chrysalis observation terminal. **Record archive** is your history view; **Settings & data** contains account and export controls. The **CRT FX** button toggles a static terminal texture and remembers the choice in this browser. Reduced-motion settings turn that texture off.

- Open `/tracker/` in your browser. Optional: install it from your browser menu, or Safari's Share → Add to Home Screen.
- In Settings, sign in with your shared lidoll.dev account to connect this device. Connecting uploads existing entries and future changes; the organizer can use synced records for analysis.
- You can also choose **Sign in to sync** beside the save status at the top of any page. After signing in, **Connect device** opens Settings so you can review and approve uploading this device's entries. The header button disappears once this device is connected and signed in.
- If you need an account, choose **Create account**, enter a username and a password twice, then review the app's identity access. Back in the tracker, choose **Connect & upload my entries** when ready to sync your local records.
- Check the time and enter liquids consumed since your previous saved check-in in mL. Choose **Save observation** to record it; the intake field then resets to zero.
- Choose your position, diaper number for that day, and wettings in that diaper.
- **New diaper** increases the selected number and resets its wettings to zero; save a check-in to record the change.
- The main protocol starts at 50% with your first saved record. Use **Roll** in its own card to draw using the daily chance. It saves only the roll and leaves your unfinished observation alone. A Hold pauses further rolls for ten minutes; **Save observation** and wetting logging stay available.
- In **Record a wetting**, classify each actual event once as Forced, Voluntary, Semi-involuntary, or Involuntary, including events without a roll. This is separate from the cumulative wetting snapshot in a check-in.
- Completed days with F + V >= SI + I reduce the chance by 5 percentage points. Other days, including days with no wettings recorded, increase it by 5 points. The chance stays between 20% and 80%. Open **About** in the navigation to read the protocol rules and review your daily adjustment history.
- Today affects tomorrow. Correcting a past wetting recalculates later days; recorded roll probabilities stay unchanged. Day boundaries use the timezone saved at enrollment, even on another device.
- Use the bathroom whenever needed. The random result is optional and does not record a wetting automatically.
- Review Charts or History. Edit mistakes or delete individual records in History.
- Download JSON backups in Settings. Import restores new records without duplicating identical entries. CSV exports the current history selection for spreadsheets.
- Check the save status: offline changes wait on this device until it reconnects. Reopen the app and sign in again if the session expires. Use the same account on another device to retrieve your central history.
- If Settings reports a conflict, compare the device and server copies and explicitly choose which one to keep.
- Sign out & clear device removes this device's copy after ending Little Log's session. It preserves server records; export pending changes first. Shared sign-in can remain active for other lidoll.dev apps.
- Deleting entries while connected queues deletion from the central database and other devices. Older downloaded files or server backups may retain previous copies.

Diaper defaults reset when the selected local date changes, while unsaved intake stays in the form. Today's liquid summary adds interval amounts saved on that date. Older cumulative snapshots are counted once, with only later intervals added. If an interval spans midnight, its intake belongs to the check-in date. Historical timestamps retain their recorded local day and timezone offset.

Default position is device-specific; enrollment, wettings and check-in records sync. Sync before switching devices: an offline device cannot know about another device's pending records or cooldown. You can register yourself or use an account created by the lidoll.dev administrator. No email address is collected; contact the administrator for password resets.

During a server update, offline check-ins remain on the device and retry afterward. After a frontend update, close old Little Log tabs and reopen to let the new app version activate.
