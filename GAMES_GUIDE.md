# Games in Little Log

Choose **Games** beside Stickers. Each card opens a game in a separate tab:

- **Diaper Atelier:** 3 LiDollcoins per roll, a saved collection and shared diaper bank.
- **Cozy Hangman:** 1 LiDollcoin to start; each newly revealed letter position pays 1 coin.
- **Touhou Trader:** adoption for 1 star or 25 LiDollcoins, plus parties, battles,
  potions, healing, player sales, gifts, swaps and buybacks using online coins.

Press **Sign in with LiD0llID** on the game page. Use the same account linked to
Discord. An existing LiD0llID browser login can be reused. For first-time setup,
run `/lidollid login` in Discord, complete browser consent and submit the returned
confirmation command there. Then return to Games. Unlinked accounts receive setup
instructions; the web page cannot create or switch a Discord link.

Touhou asks you to choose a shared Discord server. Collections and markets remain
separate per server. Gifts and swaps use the recipient's Discord user ID. Both
players must agree to a swap; the recipient presses Refresh in their web trade
inbox and accepts within one minute. Web offers do not send Discord notifications.

All collections, saved rounds, battle rules and payment recovery remain in
MommyBot. Little Log does not migrate or copy that data. If a wallet grant expires,
reconnect it through Discord; game sign-in does not renew wallet consent.

Games have separate eight-hour sessions. Signing out of Little Log does not sign
out of an open game. Use each game's Sign out button on shared devices. Unlinking
in Discord invalidates game sessions without deleting collections or balances.
The Games page is available offline; opening games and spending/recovering coins
requires a connection. The games are never embedded in an iframe.

## Operator setup

Deploy the matching MommyBot changes first, then this PWA. After committing and
pushing both repositories, run the existing Fedora updater for MommyBot
(`bash scripts/update-fedora.sh` from its checkout), then:

```bash
sudo bash /opt/lidoll/current/deploy/fedora-update.sh
```

`LIDOLLBOT_PUBLIC_ORIGIN` in the tracker service environment defaults to
`https://bot.lidoll.dev`. Change it only if the bot uses another HTTPS origin;
do not include `/touhou/`, `/auth/` or any other path. Local development permits
HTTP loopback origins outside production. This variable is separate from the
tracker's own `PUBLIC_ORIGIN` and the bot's `LIDOLLID_PUBLIC_ORIGIN`.

The existing `lidollbot` OIDC registration and `/auth/callback` remain in use;
no identity-provider registration change is needed. On the bot's Nginx host,
forward `/auth/`, `/diapers/`, `/hangman/` and `/touhou/` to its existing HTTP
listener. A virtual host that already proxies `/` needs no additional location.
On the tracker host, route `/tracker/games/` to Node with the rest of the app.

`server/games.mjs` redirects only fixed game names to trusted bot login paths.
It forwards no query parameters, tokens or account identifiers. `lib/games.js`
handles offline presentation. The service worker caches the public Games shell
and its module, never game redirects, cookies, API responses or payments. Both
Little Tracker and Caregiver Tracker themes share the same Games navigation.

Reload the installed PWA after deployment. Verify each card reaches its game,
complete one sign-in with an already linked account and confirm the expected
collection and Touhou server. Unit/browser fixtures cannot verify production
Nginx, Discord membership or the live identity provider.

## Checks

Run `npm test` for the configured-origin and fixed-redirect tests. With local
`PUPPETEER_MODULE` and `CHROME_PATH` set, run `node tests/games-browser.mjs` and
`node tests/theme-browser.mjs` for navigation, both themes, responsive layouts,
preserved form drafts, cached offline navigation and reconnect behavior. They
use disposable data and never spend real coins.


The potty tracker's top-right **Join Discord** link opens https://discord.gg/D2SburkeQn in a new tab, including before sign-in.
