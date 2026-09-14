# Quest integration status

The CrowPanel companion is an admin-only statistics viewer with everyone/individual drilldown. Its API cannot write quest events, grant rewards or alter game-editor definitions. See [STATISTICS_API.md](STATISTICS_API.md).

This standalone tracker does not contain quests, a game runtime, or a quest editor. No quest assets were supplied. Its main daily probability protocol records check-ins and classified wetting events independently of any future game progression. GENERATION_TUNING_GUIDE.md documents the protocol; observation and wetting logging remain available during random-roll cooldowns. Rolling and saving observations are separate actions.

The recovered Chrysalis terminal styling references the public site's diagnostic-archive presentation. Its terminal code and margin note are decorative interface fiction, not implemented quests, unlock conditions, or new canonical game events.

If quests are added through the original game later, document their actual schema and editor workflow here after inspecting that source. Do not make completing a prompt a prerequisite for logging, correcting, exporting, or deleting personal records.

Future game apps can use the shared lidoll.dev identity service described in AUTH_GUIDE.md. Register a separate OIDC client and keep game progress separate from tracker records and permissions.


## Growth Chart integration (2026-09-12)

The game website's promotional Growth Chart is now bundled in this PWA and
links to the same shared account as observations. Its orb-derived text remains
authored in the game checkout; chart sync does not change quests, game saves
or game_editor_gui.py fields. See GROWTH_CHART_GUIDE.md.


## Additional event choices

Bedwetting and Used the potty are separate choices in Record a wetting and its edit dialog. Both retain their category through history, JSON/CSV and account sync. Used the potty does not increase the suggested diaper wetting total. Both count as recorded events for interval estimates, but have no F/SF/V/SI/I probability weight, ordinal action score or category performance bonus; a day with none of the original five categories follows the existing empty-day rule. These recording choices add no quest or game editor fields.


## Shared recording reward modal

The reward modal now appears for all three tracker record forms. It uses existing tracker sticker receipts; there are no new quest requirements or game_editor_gui.py fields.


## Login bonuses and diamonds

Login bonuses are tracker attendance rewards and do not add quests or game_editor_gui.py fields. External games can request explicit diamond wallet scopes; current game prices remain unchanged. See LOGIN_BONUSES_GUIDE.md and LIDOLLCOIN_API.md.

## Administrator reports

AI analysis is an admin-console reporting tool. It introduces no quest definitions or game_editor_gui.py fields. Its prompt and worker configuration are documented in [AI_ANALYSIS_GUIDE.md](AI_ANALYSIS_GUIDE.md).

## New-account funds

Linked games may see a new Little Log account's 50-coin welcome balance before any quest rewards. Keep quest payouts relative to the current wallet balance; game_editor_gui.py and quest definitions need no new fields. See [ECONOMY_GUIDE.md](ECONOMY_GUIDE.md).

## Report consumers

The report API is a read-only administrator integration for MommyBot; it adds no quest or game_editor_gui.py fields and cannot grant game rewards. See [AI_REPORT_API.md](AI_REPORT_API.md).

The MommyBot report feed includes midnight Los Angeles reports and explicit **Run and share with MommyBot** requests. Ordinary manual analysis stays private; report sharing does not create quest events.
