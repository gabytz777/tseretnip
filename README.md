# Tseretnip

A small, self-contained instance of the Pinterest web API captured in
`updatedpinteresthar.har`, plus a clean frontend written from scratch.

The HAR defines the contract: the web client calls
`GET|POST /resource/<ResourceName>/<get|create|update>/` with a JSON `data`
parameter, and every response uses the envelope:

```json
{
  "resource_response": { "data": [ /* resource payload */ ], "bookmark": "..." },
  "client_context": { "...": "..." },
  "resource": { "name": "...", "options": {} },
  "request_identifier": "..."
}
```

This project implements that contract over Express + SQLite. It does **not**
replay Pinterest's proprietary JavaScript/CSS bundle.

## Layout

```
pinterestremake/
├── updatedpinteresthar.har     # private local capture — NOT part of the published repo
├── extract/
│   ├── extract.py              # HAR -> images + seed.json
│   ├── images/                 # generated placeholder images (re-run extract.py with
│   │                           #   your own capture to regenerate real ones)
│   ├── images_index.json       # URL -> local file mapping
│   └── seed.json               # distilled pins/boards/users/static blobs (anonymized)
└── server/
    ├── index.js                # Express app + /resource dispatcher
    ├── db.js                   # SQLite schema, migration and seed
    ├── auth.js                 # scrypt passwords, sessions, signup/login
    ├── shapes.js               # HAR-shaped pin/user/board builders
    ├── verify.js               # live-vs-HAR field-name diff + write test
    ├── routes/resources.js     # per-resource handlers
    └── public/                 # own frontend (HTML/CSS/JS) + local images
        └── uploads/            # images uploaded with created Pins (runtime)
```

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite` module; no native build)
- Python 3 (only needed to re-run the extractor; it uses the standard library)

## Run it

From the repository root:

```bash
npm install --prefix server   # once
npm start
# open http://localhost:3000
```

`npm start` forwards to the server in `server/`. You can also run it directly:

```bash
cd server
npm install
npm start
```

If port 3000 is already in use:

```bash
PORT=3001 npm start
```

On startup the server copies extracted images into `server/public/img/` (if
needed) and upserts `extract/seed.json` into `server/pinterest.db`. Saves and
reactions are kept in SQLite across restarts.

There is **no default account**. The first visit shows a login/sign-up screen;
create your own account (or log in with one you created earlier) to use the
feed. The seeded profile is anonymized placeholder content — it has no
password hash and cannot be logged into.

To reset the database:

```bash
rm server/pinterest.db server/pinterest.db-wal server/pinterest.db-shm
npm start
```

## Re-running the extractor

```bash
python3 extract/extract.py
# or with a different capture:
python3 extract/extract.py /path/to/capture.har
```

The extractor writes:

- `extract/images/` — every embedded `i.pinimg.com` image
- `extract/images_index.json` — original URL -> local filename
- `extract/seed.json` — feed pins, boards, users, profile, search-tab modules,
  typeahead suggestions, experiences, and other static response blobs

The repository ships **generated placeholder images** and an **anonymized
seed** (fake usernames and names, and no e-mail addresses or credentials) so no
scraped personal data is published. Some nested raw response blobs still carry
public `i.pinimg.com` image URLs from the capture; they are metadata, not
personal data. Running the extractor against your own capture regenerates both
from your data — keep the capture and its outputs private.

Only Pins described by a JSON resource response are seeded; images that merely
appeared in the page markup are not turned into filler Pins.

### What is deliberately not copied

The extractor recursively drops cookies, auth/session tokens, passwords,
recaptcha/fingerprint payloads, tracking parameters, and e-mail addresses. The
mock `/v3/users/me/` and batch responses generate a fake
`<username>@example.local` address instead. No credentials are stored anywhere.

## Implemented resources

| Resource | Behaviour |
| --- | --- |
| `UserHomefeedResource` | 24 pins/page, HAR feed order, base64 bookmark cursor |
| `UserResource` | `profile`, `grid_item`, `save_behavior` field sets |
| `BoardsResource` | user's boards, `page_size` + bookmark pagination |
| `BoardFeedResource` | pins saved to / owned by a board, paginated |
| `PinResource` | closeup pin shape (`auth_web_main_pin`); `create` publishes an uploaded Pin |
| `RelatedPinsResource` | same-board/creator pins first, then the feed |
| `SearchTabResource` | search over seeded pins; seeded story modules when empty |
| `AdvancedTypeaheadResource` | captured recent queries + live pin/user suggestions |
| `ConversationsResource` | empty list (as captured) |
| `NewsHubBadgeResource` | captured counts |
| `UserExperiencePlatformResource` / `UserExperienceResource` | captured experience maps |
| `ApiResource` | `/v3/users/me/`, metadata, search, ghost queries, gen-AI interests, recent stories, batch, saves, reactions |
| `UserSessionResource` | `get` current session, `create` sign up / log in, `update` log out or edit profile (name, username, about, flags, photo) |
| `AggregatedCommentResource` | list comments on a Pin; `create` posts one |
| `UserNetworkResource` | followers / following list for a profile |
| `ApiSResource` / `ApiCResource` / `UserRegisterTrackActionResource` | logging acknowledgements |
| `ActivateExperimentResource` | experiment groups |

## Accounts and sessions

Sign-up and login use the captured `UserSessionResource` transport:

- `POST /resource/UserSessionResource/create/` with
  `options.mode = "signup"` and `full_name`, `username`, `email`, `password`.
- `POST /resource/UserSessionResource/create/` with
  `options.mode = "login"` and `identifier` (username or email), `password`.
- `GET /resource/UserSessionResource/get/` returns
  `{ authenticated, user }` for the current cookie.
- `POST /resource/UserSessionResource/update/` with
  `options.action = "logout"` clears the session, or with
  `options.action = "update_profile"` updates name, username, about, flags, and
  (optionally) a base64 profile photo.

Passwords are hashed with Node's `scrypt` and a per-user salt; plaintext is
never stored. Sessions live in the `sessions` table and are carried by an
`HttpOnly`, `SameSite=Lax` `pr_session` cookie valid for 30 days. Usernames and
emails are unique case-insensitively. A new account starts with its own
`Quick saves` board.

Every feed, board, search, closeup, save, and reaction request resolves the
current user from that cookie. Logged-out requests therefore see no saved or
reacted state, and writes return `unauthorized`. The seeded
`thistlebay` profile remains in the seed data as a normal user for the
feed/profile fixtures, but it is not `is_me` and cannot authenticate.

`UserSessionResource/create` without a `mode` keeps the captured HAR response
shape (`success` + `session_accounts`) for compatibility with `verify.js`; it
deliberately does not create a session.

Writes are persisted in SQLite:

- create Pin: `POST /resource/PinResource/create/` with
  `options.title`, `options.description`, `options.board_id`, and
  `options.image` (a `data:image/png|jpeg|webp|gif;base64,...` URL), plus
  `options.width`/`options.height`. The file is written to
  `server/public/uploads/`; images are limited to 8 MB.
- save: `POST /resource/ApiResource/create/` with
  `options.url = /v3/board/<board_id>/pin/<pin_id>/save/`
- react: `POST /resource/ApiResource/update/` with
  `options.url = /v3/pins/<pin_id>/reaction/`

Created Pins belong to the session user, are saved to the chosen board, and are
ranked ahead of the seeded feed. Uploaded files and Pin rows survive restarts.

## Frontend

`server/public/` is a hand-written frontend rebuilt to follow Pinterest's
current web layout: a sticky header with the logo, Home / Explore / Create,
a pill search field, notification and profile controls; a centred masonry feed
of rounded pin cards; and a two-pane pin closeup.

- Masonry is placed in JavaScript using shortest-column packing (2–7 columns
  depending on viewport width) and re-laid out on resize. It is not CSS
  `column-count`, so card order stays stable across breakpoints.
- Cards show a hover overlay with Save, share, and more actions. Save writes
  through `ApiResource/create`; the Saved state is read back from SQLite.
- The header's Create menu opens a Pin composer: pick or drag in a PNG/JPG/
  WebP/GIF, add a title, description, and board, then publish. The new Pin is
  written through `PinResource/create`, appears first in the feed, and is added
  to the chosen board.
- Infinite scroll follows the `bookmark` cursor. The seed has one page (24
  Pins); newly created Pins are ranked above it.
- The closeup shows the image, title/description, creator, board, comments,
  reaction and save controls, and a custom save-to-board popover.
- Search uses debounced `AdvancedTypeaheadResource` suggestions with keyboard
  navigation. Explore reuses the feed with topic chips; the avatar opens a
  profile/board grid, and board cards open that board's feed.
- Logged-out visitors get a responsive login/sign-up screen before the app
  shell is shown. Logging out from the profile returns to that screen.
- Comments are stored in SQLite through `AggregatedCommentResource` (not part
  of the captured API shape), so every visitor sees the same thread. The
  displayed count adds live comments to the seeded count, and comments are
  removed when their Pin or author is deleted.
- Profiles can show up to four pride flags beside the name. They are picked in
  the Edit profile dialog and stored on the user row; the flags are drawn with
  inline gradients, so no extra image assets are needed.
- Follower and following counts open a connections dialog
  (`UserNetworkResource`) with follow/unfollow controls.
- **Link embeds**: shared URLs render a card in Discord/Slack/etc. The server
  injects `og:`/`twitter:` meta into the app shell per URL (crawlers don't run
  JS). A `?pin=<id>` link — the shareable closeup — embeds that pin's title,
  description, and image as a large card; other pages get a site card with the
  logo. Image URLs are built from the request's `Host` (and
  `X-Forwarded-Proto` behind a proxy), so it works under any hostname.
- Views have real URLs (`/explore`, `/search?q=…`, `/profile`, and
  `/<username>` for public profiles). The admin panel
  is split into pages: `/admin` (overview), `/admin/accounts`, `/admin/pins`
  (also accepted as `/admin/posts`), and `/admin/log`. They reload, link, and
  respond to browser back/forward like normal pages.

Known approximations: the proprietary Pinterest Sans font and Gestalt icon set
are replaced by system fonts and inline SVG icons. The UI was rebuilt from the
captured page structure rather than copying
Pinterest's bundle or HTML, so spacing and some control details are close
approximations rather than pixel-exact reproductions.

## Verification

With the server running you can poke the API directly:

```bash
curl -s 'http://localhost:3000/health'
curl -s 'http://localhost:3000/resource/UserHomefeedResource/get/?data=%7B%22options%22%3A%7B%22field_set_key%22%3A%22hf_grid%22%7D%7D'
```

Or run the automated check, which starts its own server on port 4100 with a
throw-away database, creates a throw-away account through
`UserSessionResource/create` (sign-up) and keeps its cookie, compares live field
names against the HAR for every captured resource, exercises save/react, then
restarts the server to prove SQLite persistence. It needs your own capture at
`updatedpinteresthar.har` next to the repo root (not included here); entity-id
keys are compared id-agnostically since the anonymized seed randomizes them:

```bash
cd server
node verify.js
```

Expected tail:

```
[ok] saved state survived restart
[ok] reaction state survived restart (14 -> 15)
[verify] PASS
```

## Notes / deviations from the original plan

- Storage uses Node's built-in `node:sqlite` instead of `better-sqlite3`. The
  SQLite schema and behaviour are the same, but there is no native compilation
  step. This keeps `npm install` to Express only.
- `BoardFeedResource` and `RelatedPinsResource` are implemented even though the
  capture only contains a failed/empty pin-closeup request; the shapes follow
  the feed/board nodes that *were* captured.
- Responses include a few live-only fields (`saved_info`, `repin_count`,
  `comment_count`, board `owner`/cover fields) so the frontend can show state.
  `verify.js` reports those as "extra" rather than failures.
- The current user is resolved only from the session cookie, not from an
  `is_me` seed flag. The captured profile is ordinary seed data and cannot be
  logged into; this is intentional so the instance never acts as the captured
  Pinterest account.
- Earlier builds synthesised image-only filler Pins. They are gone from the
  seed, and startup deletes any `source = 'image-only'` rows left in an older
  database.

## License

This project is licensed under the **GNU General Public License v2.0**
(SPDX: `GPL-2.0-or-later`) — see [LICENSE](LICENSE).

## Disclaimer

Tseretnip is an independent hobby project for studying how a pin-board web API
is shaped. It is **not affiliated with, endorsed by, or connected to Pinterest
or Pinterest, Inc.** in any way. "Pinterest" is a trademark of Pinterest, Inc.;
no Pinterest assets, code, or proprietary bundles are included — the repository
ships generated placeholder images and an anonymized seed. Do not use it to
impersonate Pinterest or infringe on its trademarks.
