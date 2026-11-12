# Tseretnip

A self-hosted pin-board app. It has a masonry feed, boards, pin closeups,
search, comments, profiles, and an admin panel.

The backend is a small Express + SQLite server that exposes a
`/resource/<ResourceName>/<get|create|update>/` API. The frontend is plain
HTML, CSS, and JavaScript with no build step.

## Features

- Masonry feed with hover actions and infinite scroll.
- Boards: create boards, save pins to them, and browse a board's feed.
- Pin composer: upload a PNG/JPG/WebP/GIF, add a title, description, and board.
- Pin closeup with creator, board, comments, reactions, and save controls.
- Search with debounced typeahead suggestions and keyboard navigation.
- Profiles with editable name, username, about text, photo, and up to four
  pride flags, plus a followers/following dialog.
- Real URLs for every view (`/explore`, `/search`, `/profile`, `/<username>`,
  `/admin`, …), so reload, links, and browser back/forward work.
- Link embeds: the server injects `og:`/`twitter:` meta so shared links render
  a card in Discord, Slack, and similar apps.
- Deleting: remove your own pins and comments, behind a confirmation dialog;
  admins can remove anyone's.
- Usernames change at most once every 7 days, and the profile form says when
  the field unlocks again.
- Admin panel for accounts, pins, warnings, and moderation history, including
  an account editor for name, username, about text, and flags.
- Accounts with scrypt-hashed passwords and cookie-based sessions.

## Tech stack

- Node.js 22.5+ (uses the built-in `node:sqlite` module, so there is no native
  build step).
- Express 5.
- SQLite for persistent state.
- Vanilla JavaScript, HTML, and CSS for the frontend.

## Layout

```
.
├── package.json                # root convenience scripts
├── extract/
│   ├── extract.py              # demo data generator
│   ├── images/                 # bundled demo images
│   ├── images_index.json       # source URL -> local filename
│   └── seed.json               # bundled demo pins, boards, users, blobs
└── server/
    ├── index.js                # Express app and /resource dispatcher
    ├── db.js                   # schema, migrations, seeding
    ├── auth.js                 # passwords and sessions
    ├── shapes.js               # API response builders
    ├── verify.js               # development response-shape check
    ├── routes/resources.js     # per-resource handlers
    └── public/                 # frontend and local assets
        └── uploads/            # images uploaded with created pins (runtime)
```

## Requirements

- Node.js **22.5+**
- Python 3 (optional; only needed to regenerate the demo data)

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

On startup the server copies the demo images into `server/public/img/` if
needed and upserts `extract/seed.json` into the database. Saves, comments,
reactions, and accounts persist in SQLite across restarts.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `server/pinterest.db` | SQLite database file |

To reset the database, stop the server and delete `server/pinterest.db`,
`server/pinterest.db-wal`, and `server/pinterest.db-shm`, then start it again.

## Accounts and sessions

There is no default account. The first visit shows a login/sign-up screen;
create an account to use the feed. The bundled demo profile has no password
hash and cannot be logged into.

Sign-up and login use the `UserSessionResource` endpoints:

- `POST /resource/UserSessionResource/create/` with `options.mode = "signup"`
  and `full_name`, `username`, `email`, `password`.
- `POST /resource/UserSessionResource/create/` with `options.mode = "login"`
  and `identifier` (username or email) plus `password`.
- `GET /resource/UserSessionResource/get/` returns
  `{ authenticated, user }` for the current cookie.
- `POST /resource/UserSessionResource/update/` with
  `options.action = "logout"` clears the session, or with
  `options.action = "update_profile"` updates name, username, about, flags,
  and (optionally) a base64 profile photo. A username change is limited to one
  every 7 days; see [Writes](#writes).

Passwords are hashed with Node's `scrypt` and a per-user salt; plaintext is
never stored. Sessions live in the `sessions` table and are carried by an
`HttpOnly`, `SameSite=Lax` `pr_session` cookie valid for 30 days. Usernames
and e-mails are unique case-insensitively. A new account starts with its own
`Quick saves` board.

Every feed, board, search, closeup, save, and reaction request resolves the
current user from that cookie. Logged-out requests therefore see no saved or
reacted state, and writes return `unauthorized`.

## API

Every response uses the same envelope:

```json
{
  "resource_response": { "data": [ /* resource payload */ ], "bookmark": "..." },
  "client_context": { "...": "..." },
  "resource": { "name": "...", "options": {} },
  "request_identifier": "..."
}
```

| Resource | Behaviour |
| --- | --- |
| `UserHomefeedResource` | 24 pins/page, base64 bookmark cursor |
| `UserResource` | `profile`, `grid_item`, `save_behavior` field sets |
| `BoardsResource` | a user's boards, `page_size` + bookmark pagination |
| `BoardFeedResource` | pins saved to or owned by a board, paginated |
| `PinResource` | pin closeup shape; `create` publishes an uploaded pin, `update` deletes one |
| `RelatedPinsResource` | same-board/creator pins first, then the feed |
| `SearchTabResource` | search over seeded pins; story modules when empty |
| `AdvancedTypeaheadResource` | recent queries plus live pin/user suggestions |
| `ConversationsResource` | empty list |
| `NewsHubBadgeResource` | notification counts |
| `UserExperiencePlatformResource` / `UserExperienceResource` | experience maps |
| `ApiResource` | user metadata, search, ghost queries, interests, stories, batch, saves, reactions |
| `UserSessionResource` | session get/create/update (sign up, log in, log out, edit profile) |
| `AggregatedCommentResource` | comments on a pin: `get` lists them, `create` posts one, `update` deletes one |
| `UserNetworkResource` | followers / following list for a profile |
| `ApiSResource` / `ApiCResource` / `UserRegisterTrackActionResource` | logging acknowledgements |
| `ActivateExperimentResource` | experiment groups |

### Writes

- Create a pin: `POST /resource/PinResource/create/` with `options.title`,
  `options.description`, `options.board_id`, `options.width`/`options.height`,
  and `options.image` (a `data:image/png|jpeg|webp|gif;base64,...` URL). The
  file is written to `server/public/uploads/`; images are limited to 8 MB.
- Save a pin: `POST /resource/ApiResource/create/` with
  `options.url = /v3/board/<board_id>/pin/<pin_id>/save/`.
- React to a pin: `POST /resource/ApiResource/update/` with
  `options.url = /v3/pins/<pin_id>/reaction/`.
- Delete a pin: `POST /resource/PinResource/update/` with
  `options.action = "delete"` and `options.id` (or
  `POST /resource/ApiResource/update/` with
  `options.url = /v3/pins/<pin_id>/delete/`). The owner or an admin may
  delete; anyone else is refused with `403`. Seeded pins are tombstoned in
  `deleted_pins`, so the demo seed does not bring them back on the next start,
  and the pin's uploads, comments, reactions, and saves go with it.
- Delete a comment: `POST /resource/AggregatedCommentResource/update/` with
  `options.id` (and optionally `options.pin_id`). The comment's author, the
  pin's owner, and admins may delete.
- Change a username: `POST /resource/UserSessionResource/update/` with
  `options.action = "update_profile"`. A change is allowed once every 7 days;
  the last one is stored in `users.username_changed_at` (added by the startup
  migration) and the profile and session responses carry `username_changed_at`
  and `username_change_available_at` so the form can show when the field
  unlocks. Changing it again too soon answers `429`. Saving the rest of the
  profile with the current username stays allowed. Usernames are stored
  lowercase, so a case-only edit is not a change, and a staff edit through the
  admin panel neither uses nor starts the window.

Created pins belong to the session user, are saved to the chosen board, and
are ranked ahead of the demo feed. Uploaded files and pin rows survive
restarts.

## Frontend

`server/public/` is a hand-written frontend:

- The feed uses shortest-column masonry packing (2–7 columns depending on
  viewport width) and re-lays out on resize, so card order stays stable across
  breakpoints.
- Cards show a hover overlay with Save, share, and more actions. Saved state is
  read back from SQLite.
- The Create menu opens a pin composer with drag-and-drop or file picking.
- Infinite scroll follows the `bookmark` cursor.
- The closeup shows the image, title/description, creator, board, comments,
  reaction and save controls, and a save-to-board popover.
- The closeup's more button opens an action menu with *Copy link* plus *Delete
  pin* for the pin's owner and for admins. Deleting asks for confirmation,
  drops the card from the grid immediately, and (for staff deleting someone
  else's pin) is written to the moderation log.
- Comments are stored in SQLite, so every visitor sees the same thread. The
  author of a comment, the owner of the pin, and admins get a trash button on
  the comments they may remove, also behind a confirmation dialog.
- The edit-profile form keeps the username field visible but read-only while
  the 7-day window is closed, and says on which date it reopens. The server
  enforces the same rule if the form is bypassed.
- The admin panel's *Edit* action opens a form with full name, username, about,
  and the flags, so staff can fix a profile (or clear its flags) without
  asking the account holder. Staff edits skip the username window and still
  have to pass the same handle rules and uniqueness check as the public form.
- Explore reuses the feed with topic chips; the avatar opens a profile/board
  grid, and board cards open that board's feed.
- Logged-out visitors get a login/sign-up screen before the app shell.
- Profile flags are drawn with inline gradients, so no extra image assets are
  needed.
- Link embeds inject `og:`/`twitter:` meta per URL, since crawlers do not run
  JavaScript. A `?pin=<id>` link embeds that pin as a large card; other pages
  get a site card. Image URLs are built from the request `Host` (and
  `X-Forwarded-Proto` behind a proxy), so they work under any hostname.

Known approximations: the proprietary web font and icon set are replaced by
system fonts and inline SVG icons. Spacing and some control details are close
approximations rather than pixel-exact reproductions.

## Demo data

The repository ships anonymized demo content (fake usernames and names, no
e-mail addresses or credentials) and generated placeholder images, so it runs
without any external data. The `extract/` directory contains the data
generator together with the generated `seed.json`, `images_index.json`, and
images.

## Health check

With the server running you can check the API directly:

```bash
curl -s 'http://localhost:3000/health'
curl -s 'http://localhost:3000/resource/UserHomefeedResource/get/?data=%7B%22options%22%3A%7B%22field_set_key%22%3A%22hf_grid%22%7D%7D'
```

## License

This project is licensed under the **GNU General Public License v2.0**
(SPDX: `GPL-2.0-or-later`) — see [LICENSE](LICENSE).

## Disclaimer

Tseretnip is an independent hobby project for studying how a pin-board web app
is built. It is **not affiliated with, endorsed by, or connected to Pinterest,
Inc.** in any way. "Pinterest" is a trademark of Pinterest, Inc.; no Pinterest
assets, code, or proprietary bundles are included. Do not use it to impersonate
Pinterest or infringe on its trademarks.
