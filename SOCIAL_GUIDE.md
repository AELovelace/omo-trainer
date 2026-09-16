# Status updates, pictures, activity and moderation

Open **Social** in the main menu. Its bottom bar switches between **Post**, **Feed**,
**Friends & search**, **Messaging**, **Notifications**, and **Profile** on phones and desktop.
Friends & search manages friend requests and shared records. The recording action
bar gives way to this social bar while browsing Social.

On phones (up to 680px wide), the header and bottom tabs stay in place while
the middle content scrolls. Cards and controls are compact; extra instructions
are under expandable help. Long posts have More/Less controls. Desktop keeps
its existing layout.

Open **Post** to write text, add up to four pictures, or both. **Feed** is a
separate browsing view. Switching tabs keeps the unsent text, pictures and
audience in memory; after publishing, choose **View your post** to open it. Each post has a
**Friends** or **Public** audience. Friends is the default. Public means all
signed-in, enabled Little Log members; signed-out visitors cannot read the feed
or its pictures. Use Show updates to switch between Friends & me and Public.
Friends & me includes your posts and current friends' posts, including public
ones. Older updates loads another 20 posts. You can delete your own posts.

Friend posts are visible to current accepted friends. Removing a friendship
stops future reads of those posts and pictures; accepting a new or renewed
friendship grants access to that person's earlier friend posts too. Public posts
remain visible to members after a friendship ends. Deletion or disabled accounts
hide posts and pictures on subsequent reads. Access changes cannot undo copies
someone has already saved.

Statuses allow 2,000 characters. Choose still JPEG, PNG or WebP pictures and
optionally describe each picture for accessibility. The browser resizes pictures
before upload. The server independently decodes and re-encodes them as JPEGs up
to 1,600 pixels on each side, removing original metadata and filenames. Each
uploaded picture is limited to 2 MiB; each account can store 100 MiB of pictures.
Delete old picture posts to free space. New posts are limited to ten per minute.

Open **Messaging**, or select **Message** beside an accepted friend, to start a
private text conversation. Messages allow 4,000 characters, with a limit of 60
per minute. The page shows unread counts and checks for new messages every ten
seconds while visible. Older messages loads earlier history in pages of 50.
You can remove your own messages, leaving a Message removed placeholder.
Removing a friend deletes the conversation for both accounts; becoming friends
again starts a fresh conversation. Messages are stored on the server and are
not end-to-end encrypted.

Messaging is also the last shortcut in the main mobile bottom bar, after Pattern
analysis. Both Messaging shortcuts show a numbered unread badge (99+ for larger
counts). Counts refresh every 15 seconds while the app is visible and after a
conversation is read. Opening the inbox alone does not clear the badge.

New-message pushes are on by default for notification subscribers. Opt out with
**Settings → Social notifications → New messages from friends**, then save.
Pushes contain the sender's display name and a generic notice, not message text;
tapping one opens Messaging. Stored notifications offer **Open conversation**.
Reading a thread marks its message alerts read and cancels pending pushes.
Disabling message pushes leaves the unread badge and stored activity available.

On mobile, Messaging opens a compact inbox with previews and unread counts.
Search conversations or choose Inbox, Unread, All mail or Archived. **New**
opens the friend picker. Open a conversation to read it and reply; **Inbox**
returns to the list. Replies stay below the scrolling history, and unsent drafts
are kept per friend in memory until sign-out, disconnect or reload. Opening the
inbox alone does not mark messages read. Ctrl+Enter sends a reply on mobile.

**Archive** hides a conversation from your inbox only; it neither deletes mail
nor changes your friend's inbox. Open Archived or All mail to read or restore
it. A new message brings it back to the inbox automatically. Archive choices
persist across devices and server restarts.

Posting and messaging require a connection. Social data is fetched live and is
not stored in the offline shell or local storage. Signing out clears the social
views and drafts. Status posts and messages do not earn recording rewards or
send Community support notifications.

## Automatically posting bathroom records

In **Settings → Records on your timeline**, opt into **Automatically post my
bathroom and water logs** and choose **Private (friends only)** or **Public (all
members)**, then save. This is off for everyone until they opt in. It works
independently of push notifications and Community support, across devices.

New wettings (including accidents, bedwetting and used-the-potty records) and
diaper changes and water/liquid logs create short timeline posts when first synced. Posts contain the
classification and recorded time; diaper changes also include the final wetting
count; water/liquid logs include the intake amount in mL. Rolls, position and diaper numbers are not posted. Already-synced
records are not backfilled; offline and backdated records first synced while
enabled do post. Administrator imports never create new posts.

Private posts are visible to you and accepted friends. Public posts are visible
to all signed-in members. Changing the audience or switching sharing off affects
future posts only. Correcting a shared record updates its post; deleting the
record removes the post and associated activity. You can also delete a post
without deleting the record. Edits and retries cannot restore a deleted post.
Posts support the same likes, comments, reports and moderation as manual updates,
and friends receive their usual new-post notification according to their settings.

In **Settings → Social notifications**, recipients can separately turn off
**Accidents & potty visits**, **Changies (diaper changes)** or **Water logs**.
These filters apply to automatic record-post pushes and require **New posts from
friends** to be on. They start on and preserve saved opt-outs across devices.
Turning a type off cancels its queued pushes. Posts and stored activity remain
available, and the recipient's own timeline-sharing choice is unchanged.

## Likes, comments and reports

Use **Like** or **Unlike** on an accessible post. Each member has at most one
like per post. Open **Comments** to read or write comments, up to 2,000
characters each. Comments show 30 per page; new comments are limited to 20 per
minute per member. Both the comment author and the post owner can delete a
comment. Likes and comments follow the post's Friends/Public audience, and
removing the post removes its pictures, likes and comments too.

Choose **Report post**, **Report comment** or **Report message** and provide a
reason to ask administrators to review content. Reports are visible only to
administrators, with the reporter's identity. A repeated report from the same
member on the same item does not duplicate the queue; reporting is limited to
20 new reports per hour. Reporting a private message exposes that message to
administrators, not the rest of the conversation.

## Activity and social push notifications

**Notifications** (the activity feed) stores likes and comments on your posts and new posts by your
accepted friends, whether or not you have push enabled. Self-likes/comments do
not notify you. New admin announcements and community check-in notices are also
saved when their first delivery is attempted, and selected potty reminders are
saved when due. History starts with this deployment; old notifications are not
backfilled. Stored anonymous check-ins remain anonymous. Community-support
notices appear only while the recipient's saved Community support setting is
enabled. Turning it off hides those notices and excludes them from unread
counts and mark-as-read actions; other push history stays visible. Turning it
on again shows previously stored notices with their read state preserved.
Community notices are not recorded while the setting is off.

View unread counts, mark individual notifications or all loaded-through
notifications as read, and open the relevant post. Older activity loads another
30 items. Activity is stored on the server and survives device changes. It is
not downloaded for offline use. Removed content and revoked audiences disappear
from activity on subsequent reads; restoring a friendship does not restore its
withdrawn notifications. Read status is separate from push delivery status.

Settings > Receive notifications has three independent account-wide options:
**Likes on my posts**, **Comments on my posts**, and **New posts from friends**.
They default on for first-time notification enables and are enabled once for
existing notification subscribers by the database column migration. Later
opt-outs survive restarts, re-enabling and adding devices. Uncheck and save to
stop that type of push; stored activity continues. These settings control
receiving pushes, independently of the Community support sharing settings.

Social events snapshot the recipient's subscribed devices when the event is
saved, within the content transaction. Push payloads contain the actor's display
name and the action, not post text, comment text or images. Names may appear on
lock screens. Clicking a social push opens Activity. The minute worker rechecks
live account, content, audience, subscription and preference access before
sending. Quiet hours delay pushes for up to 24 hours. Device removal, opting out,
content removal or loss of access cancels pending deliveries permanently.
Retries of posts/comments and repeated like toggles cannot generate duplicate
pushes. Transport attempts are claimed before sending and are not automatically
retried after an uncertain failure. Expired pushes still leave readable activity
when the underlying content remains accessible. Delivery to a push service does
not confirm that a device displayed the notification.

## Admin social moderation

Open **Admin console > Social moderation**. **Open reports** shows reports and
their current content; **All posts** lets admins browse Friends and Public posts,
review protected pictures and open their comments. **Paused social accounts**
lists current restrictions. Enter a reason before each decision. Admins can
remove posts, comments and reported messages, dismiss reports, pause social
access, or restore access. Pausing prevents new posts, likes, comments and
messages while allowing reading and reporting. User management still controls
full account disablement. Removed content cannot be restored by a retry.

Every moderation read, protected image request and mutation checks the admin's
current role. Private messages are reviewable/removable only after a participant
reports that message. Decisions and reasons appear in the existing admin
Activity log, without copying private message bodies into audit records.

## Implementation and API

`server/social.mjs` owns social tables in `little-log.sqlite` and verifies live
participant and friendship access. `lib/social.js` renders text safely, prepares
pictures and keeps retry request IDs stable. Every endpoint requires a current
enabled session and same-origin access. POSTs also require the session's CSRF
token. Responses, including picture bytes, use `Cache-Control: no-store`.

| Endpoint under `api/social/` | Method | Input / result |
| --- | --- | --- |
| `session` | GET | Participant and CSRF for the Post composer; no feed or records |
| `feed` | GET | `audience=friends/public`, optional `before`; `items`, `nextBefore`, participant and CSRF |
| `posts` | POST | `requestId`, `body`, `audience`, `pictures: [{data: base64, alt}]`; post ID |
| `posts/delete` | POST | Owner-only post `id`; deletes pictures and clears text |
| `picture` | GET | Picture `id`; JPEG bytes after live audience check |
| `conversations` | GET | Accepted friends, latest message and unread counts; participant and CSRF |
| `messages` | GET | `participantId`, optional `before`; chronological `items`, `nextBefore` |
| `messages` | POST | `requestId`, `participantId`, `body`; message ID |
| `messages/read` | POST | `participantId`, loaded message `seq`; monotonic read marker |
| `messages/delete` | POST | Sender-owned message `id`; clears message text |
| `post` | GET | Post `id`; one post with current audience checks |
| `like` | POST | `postId`, boolean `liked`; current counts and viewer like state |
| `comments` | GET | `postId`, optional `before`; chronological `items`, `nextBefore` |
| `comments` | POST | `requestId`, `postId`, `body`; retry-safe comment ID |
| `comments/delete` | POST | Comment `id`; author or post owner only |
| `report` | POST | `kind: post/comment/message`, `id`, `reason` |
| `activity` | GET | Optional `before`; `items`, `unread`, `latest`, `nextBefore`, participant and CSRF |
| `activity/read` | POST | Notification `id` or last loaded `through` sequence |

Admin-only `GET api/admin/social` accepts `view=reports/posts/restrictions`,
optional `before`, or `postId` to inspect a post and its comments. Protected
moderation pictures use `GET api/admin/social/picture?id=...`. Admin POST
`api/admin/social` requires a reason and an action: `remove` with `kind` and
`id`, `dismiss` with `reportId`, or `restrict/restore` with `participantId`.
Existing notification preferences add booleans `socialLikes`, `socialComments`
and `friendPosts`; omitted fields preserve previously saved choices.

Stable sequence cursors prevent new writes from shifting older pages. Request
receipts prevent retries from duplicating content or resurrecting deleted posts
and conversations. Picture decoding finishes before acquiring the SQLite write
lock; access and duplicate checks run again inside the publishing transaction.

## Deployment and checks

Deploy the backend, HTML, styles, `lib/social.js`, service worker and updated npm
lockfile together. Install the pinned `sharp` dependency with `npm ci`. Tables
are created automatically at startup; include `little-log.sqlite` in private
backups because it now contains social text and pictures. The Fedora updater
installs dependencies and runs the unit tests, including actual picture decoding,
before activating the candidate release.

**Update the Nginx proxy configuration for picture uploads.** Both supplied
Nginx templates now include an exact `/tracker/api/social/posts` location with
`client_max_body_size 12m`; other API routes keep their smaller limit. Apply
that block on the proxy host, adapting the existing upstream if necessary, run
`sudo nginx -t`, then `sudo systemctl reload nginx`. Updating only the tracker
service does not update a separate proxy host. Any additional upstream proxy
must also accept this endpoint's bounded upload size.

Run `npm test` for audience isolation, protected pictures, malformed uploads,
metadata removal, pagination, deletion, retry behavior, conversation permissions,
unread markers, persistence and HTTP session/CSRF checks. With `PUPPETEER_MODULE`
and `CHROME_PATH` set, run `node tests/social-browser.mjs` for real uploads,
Friends/Public feeds, messaging and replies, responsive layouts and cache cleanup.
Also run `node tests/friends-browser.mjs` and `node tests/theme-browser.mjs` for
existing friend workflows and the nine menu destinations. Fixtures use local
disposable accounts and do not post to the production community.

Deploy `server/activity.mjs`, the updated social/notification modules and
`admin/social.js` together with the updated app and service worker. No new
environment variables are required; social pushes reuse the configured VAPID
keys and scheduler. The preference column migration runs once per column and
must never reset existing values on startup. Back up `little-log.sqlite` for
activity, reports, moderation decisions, comments and likes.

`tests/social-activity.test.mjs` verifies reactions, reports, live moderator
roles, private-message boundaries, protected moderation pictures, durable
activity/read state, migration defaults, opt-out cancellation, quiet hours,
revocation, failed transport and service worker routing. Run
`node tests/social-activity-browser.mjs` for actual likes/comments, reporting,
activity links, admin decisions and access revocation. The notification browser
test also checks all three default-on settings and persistent opt-outs. Push
transport is mocked; verify real device delivery after deployment.

The main menu has one Social destination (`#social`, which opens Feed). Existing
`#post`, `#feed`, `#feed?post=...`, `#messages`, `#activity` and `#friends` links continue
to open the matching section within Social. Browser Back/Forward and push/post
links keep working. Admin moderation stays in the admin console.

Social appears after Games and immediately before Login bonuses in the main menu.

## Profile pictures

Open **Settings > Profile picture** to choose a JPEG, PNG or WebP image, review
the square preview and press **Save picture**. Use the same controls to replace
it, or **Remove picture** to return to an initial. Pictures are visible to all
signed-in members in posts, comments, friends/search and conversations; they
are not part of anonymous community-support notices.

Uploads are resized to 512 by 512 pixels and re-encoded as JPEG without original
metadata. The browser accepts source files up to 100 MB; direct API images must
be at most 2 MB and 24 million pixels. Only still images are stored; direct
animated uploads, SVG and remote URLs are rejected. A current picture is stored
once per member in SQLite. Removed and
replaced picture versions stop loading; existing server backups may retain them.

Admins can choose **Social moderation > Profile pictures** to review pictures
and remove one with an audited reason. Paused social accounts cannot change
pictures. Removal checks the reviewed version, so a newer picture is not removed
by an older moderation screen.

Large camera photos (including 50 MP images) are resized on your device before
posting. The uploader accepts originals up to 100 MB each and reduces quality
and dimensions as needed. If the proxy rejects a picture post for its size,
it automatically retries with smaller pictures that fit the existing 256 KiB
limit, sharing the available space between the selected photos. Larger proxy
limits preserve more detail. The text, audience and descriptions stay intact.
JPEG, PNG and WebP are supported; other camera formats depend on browser
support. If HEIC cannot be opened, export the photo as JPEG or PNG.

The top-bar **Notifications** shortcut opens the same stored activity as
Social > Notifications. **Join Discord** is in the side menu below About.

Posts with multiple photos use a swipeable gallery. Swipe left or right, or use
Previous photo / Next photo; the counter shows your position. Focus the gallery
to use the arrow keys, Home or End. Photos fit inside the viewer without cropping.

Tap any posted photo, including single-photo posts, to open it fullscreen.
Swipe through the post's photos or use Previous/Next; descriptions appear below.
Close or Escape returns to the same photo and feed position. The viewer also
works on profiles and closes whenever the underlying private feed is cleared,
including sign-out or disconnect.

Open **Profile** in the Social bottom bar to see your own picture and posts.
Use **Edit profile picture** to open the upload controls in Settings. Clicking
a name or avatar in posts, comments, friends/search, shared records or messages
opens that member's profile. Conversation rows have a separate Message button.

Profiles show only posts you can already read: your own posts, friends-only posts
from accepted friends, and public posts. Profiles do not reveal tracking records,
account credentials or someone's private friend list. Disabled or missing
accounts are unavailable. Use Older posts / Newest posts to navigate history.
