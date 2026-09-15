# Friends and shared records

Open **Social** from the menu, then **Friends & search** in the bottom bar. Search by display name (2–80 characters), then
choose **Add friend**. Search shows up to 20 matching enabled members. The other
person accepts or declines the request. You can cancel a sent request or remove
an accepted friend. Each account can have up to 200 friends and pending requests
combined. Matching names are not unique; friendship uses the selected account.

In **History**, choose **Share with friend** beside a record. The dialog loads
the saved server version, so sync local records first. Review the fields, select
an accepted friend, and choose **Share this record**. This grants read-only
access to that one record, including future saved edits. It does not share the
whole timeline, chart, wallet, enrollment settings or other records.

Friends > **Shared with me** shows incoming records. **Shared by me** lets the
owner stop sharing each record with each recipient. Lists show 50 records per
page, with Older records and Newest records navigation. Sharing is idempotent;
repeating the same record/recipient selection does not create duplicate grants.
If the record changed since the preview, reopen it before sharing.

Deleting the source record revokes its shares. Removing a friend revokes all
record access between the two accounts. Restoring the record or becoming friends
again does not restore old shares. Disabled accounts cannot search, connect or
read shared records. Shared records are fetched live, never imported into the
recipient's tracker or saved for offline use. Revocation stops future reads;
it cannot undo something a recipient has already read or copied.

## Friends-only Community support

The **Message** button opens a private conversation with an accepted friend.
Removing a friendship also deletes its conversation for both people. The
**Updates** page supports friend-visible status posts and a separate Public
audience for all signed-in members. Unlike individual record grants, earlier
friend posts become visible when a friendship is accepted or renewed. See
[SOCIAL_GUIDE.md](SOCIAL_GUIDE.md) for audiences, pictures and messages.

Settings > Receive notifications > **Friends only** limits both outgoing and
incoming community check-ins to accepted friends. It defaults off, works across
devices, and is independent of **Share anonymously**. Community support must
still be enabled on both accounts, with active push subscriptions. Pending
friend requests do not count. This setting never shares record contents.

If either person selects Friends only, a check-in between them requires an
accepted friendship. The existing once-per-day trigger, anonymous option and
quiet hours still apply. Restricting the audience cancels pending notices for
non-friends. Removing a friend cancels pending friends-only notices between the
two accounts; re-adding them does not restore those notices. Expanding an
audience later does not add recipients to previously queued check-ins.

## Implementation and API

`server/friends.mjs` stores friendships and record grants in the scientific
database. Pair uniqueness prevents duplicate or crossed requests. A fresh
relationship ID prevents stale requests and old shares from reviving after
removal. Record deletion also revokes grants through a SQLite trigger, including
admin deletions. Data and mutations require a current enabled session; POSTs
also require the same-origin CSRF token. Responses use `Cache-Control: no-store`.

| Endpoint under `api/` | Method | Input / result |
| --- | --- | --- |
| `friends` | GET | Current participant, CSRF, friend/request list |
| `friends/search?q=...` | GET | Bounded display-name search |
| `friends` | POST | `action: request`, `participantId`; or `action: accept/remove`, relationship `id` |
| `friends/record?id=...` | GET | Owner-only saved record preview with version |
| `friends/share` | POST | `participantId`, `recordId`, preview `version` |
| `friends/unshare` | POST | Share `id`; owner-only revocation |
| `friends/shared?direction=incoming&offset=0` | GET | Incoming or `outgoing` grants, records and `nextOffset` |

Notification preference `communityFriendsOnly` is a boolean. Omitting it keeps
the saved choice. New settings default false. Deploy the server, public
`lib/friends.js`, HTML, CSS and service worker together; no new configuration is
needed. Existing notification enrollment and anonymity migrations are preserved.

Run `node --test tests/friends.test.mjs` for ownership, request lifecycle,
versioned sharing, deletion/removal revocation, persistence, pagination,
friends-only queues and HTTP authorization. Run `tests/friends-browser.mjs`,
`tests/notifications-browser.mjs` and `tests/theme-browser.mjs` with
`PUPPETEER_MODULE` and `CHROME_PATH` configured for browser acceptance checks.
Browser fixtures use disposable accounts; push transport is mocked.

Member pictures appear beside names in friend search, requests and shared records.
Upload or remove your own picture in **Settings > Profile picture**. Pictures
are visible to signed-in members; friendship is not required to see one.
