// Database layer: schema + seeding from the HAR-distilled extract/seed.json.
// Uses Node's built-in node:sqlite - no native compilation needed.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pinterest.db');
const SEED_PATH = path.join(ROOT, 'extract', 'seed.json');
const IMG_SRC = path.join(ROOT, 'extract', 'images');
const IMG_DST = path.join(__dirname, 'public', 'img');
const QUICK_SAVES_ID = '5053372614925226888';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      full_name     TEXT,
      first_name    TEXT,
      image_medium  TEXT,
      image_small   TEXT,
      image_large   TEXT,
      image_xlarge  TEXT,
      about         TEXT,
      email         TEXT,
      password_hash TEXT,
      country       TEXT,
      follower_count INTEGER,
      following_count INTEGER,
      board_count   INTEGER,
      pin_count     INTEGER,
      is_me         INTEGER DEFAULT 0,
      is_admin      INTEGER DEFAULT 0,
      is_banned     INTEGER DEFAULT 0,
      ban_reason    TEXT,
      banned_at     TEXT,
      is_restricted INTEGER DEFAULT 0,
      restrict_reason TEXT,
      restricted_at TEXT,
      flags         TEXT,   -- JSON array of up to 4 pride flag ids
      username_changed_at TEXT,  -- last self-service username change (7-day cooldown)
      raw_json      TEXT
    );
    CREATE TABLE IF NOT EXISTS boards (
      id        TEXT PRIMARY KEY,
      user_id   TEXT REFERENCES users(id),
      name      TEXT NOT NULL,
      url       TEXT,
      pin_count INTEGER DEFAULT 0,
      cover_url TEXT,
      image_cover_url TEXT,
      image_thumbnail_url TEXT,
      cover_images_json TEXT,
      collaborator_count INTEGER DEFAULT 0,
      is_collaborative INTEGER DEFAULT 0,
      board_order_modified_at TEXT,
      description TEXT,
      raw_json  TEXT
    );
    CREATE TABLE IF NOT EXISTS pins (
      id             TEXT PRIMARY KEY,
      title          TEXT DEFAULT '',
      description    TEXT DEFAULT '',
      dominant_color TEXT,
      created_at     TEXT,
      is_video       INTEGER DEFAULT 0,
      link           TEXT,
      domain         TEXT,
      image_sig      TEXT,
      img_url        TEXT,   -- best local image (largest captured)
      img_width      INTEGER,
      img_height     INTEGER,
      images_json    TEXT,   -- {"236x": {"url": "/img/...", "width":..,"height":..}, ...}
      repin_count    INTEGER DEFAULT 0,
      comment_count  INTEGER DEFAULT 0,
      board_id       TEXT REFERENCES boards(id),
      pinner_id      TEXT REFERENCES users(id),
      creator_id     TEXT REFERENCES users(id),
      feed_rank      INTEGER,
      reaction_counts_json TEXT,
      link_domain_json TEXT,
      image_crop_json TEXT,
      recommendation_reason_json TEXT,
      raw_json       TEXT,
      source         TEXT
    );
    CREATE TABLE IF NOT EXISTS reactions (
      pin_id    TEXT REFERENCES pins(id),
      user_id   TEXT REFERENCES users(id),
      type      INTEGER DEFAULT 1,   -- 1 = like ("good reaction")
      PRIMARY KEY (pin_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS saved (
      pin_id  TEXT REFERENCES pins(id),
      user_id TEXT REFERENCES users(id),
      board_id TEXT REFERENCES boards(id),
      created_at TEXT,
      PRIMARY KEY (pin_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower_id  TEXT REFERENCES users(id),
      following_id TEXT REFERENCES users(id),
      created_at   TEXT,
      PRIMARY KEY (follower_id, following_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id         TEXT PRIMARY KEY,
      pin_id     TEXT REFERENCES pins(id),
      user_id    TEXT REFERENCES users(id),
      text       TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS warnings (
      id              TEXT PRIMARY KEY,
      user_id         TEXT REFERENCES users(id),
      message         TEXT NOT NULL,
      created_by      TEXT,
      created_at      TEXT,
      acknowledged_at TEXT
    );
    -- Moderation history deliberately has no foreign keys so entries survive
    -- account deletion and remain readable afterwards.
    CREATE TABLE IF NOT EXISTS moderation_log (
      id             TEXT PRIMARY KEY,
      actor_id       TEXT,
      action         TEXT NOT NULL,
      target_user_id TEXT,
      target_pin_id  TEXT,
      detail         TEXT,
      created_at     TEXT
    );
    -- Seeded Pins are re-inserted on every startup.  A tombstone keeps an
    -- admin's deletion permanent without filtering every feed query.
    CREATE TABLE IF NOT EXISTS deleted_pins (
      pin_id     TEXT PRIMARY KEY,
      deleted_at TEXT
    );
  `);

  // Upgrade databases created by the first seed version in place.
  ensureColumn('users', 'image_large', 'TEXT');
  ensureColumn('users', 'image_xlarge', 'TEXT');
  ensureColumn('users', 'about', 'TEXT');
  ensureColumn('users', 'email', 'TEXT');
  ensureColumn('users', 'password_hash', 'TEXT');
  ensureColumn('users', 'country', 'TEXT');
  ensureColumn('users', 'follower_count', 'INTEGER');
  ensureColumn('users', 'following_count', 'INTEGER');
  ensureColumn('users', 'board_count', 'INTEGER');
  ensureColumn('users', 'pin_count', 'INTEGER');
  ensureColumn('users', 'raw_json', 'TEXT');
  ensureColumn('users', 'is_admin', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'is_banned', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'ban_reason', 'TEXT');
  ensureColumn('users', 'banned_at', 'TEXT');
  ensureColumn('users', 'is_restricted', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'restrict_reason', 'TEXT');
  ensureColumn('users', 'restricted_at', 'TEXT');
  ensureColumn('users', 'flags', 'TEXT');
  ensureColumn('users', 'username_changed_at', 'TEXT');
  ensureColumn('boards', 'image_cover_url', 'TEXT');
  ensureColumn('boards', 'image_thumbnail_url', 'TEXT');
  ensureColumn('boards', 'cover_images_json', 'TEXT');
  ensureColumn('boards', 'collaborator_count', 'INTEGER DEFAULT 0');
  ensureColumn('boards', 'is_collaborative', 'INTEGER DEFAULT 0');
  ensureColumn('boards', 'board_order_modified_at', 'TEXT');
  ensureColumn('boards', 'description', 'TEXT');
  ensureColumn('boards', 'raw_json', 'TEXT');
  ensureColumn('pins', 'feed_rank', 'INTEGER');
  ensureColumn('pins', 'reaction_counts_json', 'TEXT');
  ensureColumn('pins', 'link_domain_json', 'TEXT');
  ensureColumn('pins', 'image_crop_json', 'TEXT');
  ensureColumn('pins', 'recommendation_reason_json', 'TEXT');
  ensureColumn('pins', 'raw_json', 'TEXT');
  ensureColumn('pins', 'source', 'TEXT');

  // Accounts deleted from the admin panel stay deleted, even though seed()
  // re-upserts the captured data on every startup.
  db.exec(`CREATE TABLE IF NOT EXISTS deleted_users (
      user_id    TEXT PRIMARY KEY,
      deleted_at TEXT
    )`);

  // Accounts created by the app are identified by session, never by a seeded
  // "is_me" flag.  Usernames and e-mails must be unique case-insensitively.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ' +
    'ON users(lower(username));');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ' +
    'ON users(lower(email)) WHERE email IS NOT NULL;');

  // The first account registered through the app becomes the moderator.  On an
  // existing database, promote the earliest real account if none is admin yet.
  const hasAdmin = db.prepare(
    'SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!hasAdmin) {
    const first = db.prepare(
      `SELECT id FROM users WHERE password_hash IS NOT NULL
       ORDER BY rowid LIMIT 1`).get();
    if (first) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(first.id);
    }
  }
}

function ensureColumn(table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function localImage(url) {
  if (!url) return null;
  return url.startsWith('/img/') ? url : null;
}

function bestImage(images) {
  const rank = ['736x', '564x', '474x', '236x', '170x', 'orig', '1200x'];
  for (const key of rank) {
    const image = images?.[key];
    if (image?.url) return image;
  }
  return Object.values(images || {}).find((image) => image?.url) || null;
}

export function seed() {
  // serve extracted images locally (copy any missing files; idempotent)
  if (fs.existsSync(IMG_SRC)) {
    fs.mkdirSync(IMG_DST, { recursive: true });
    let copied = 0;
    for (const file of fs.readdirSync(IMG_SRC)) {
      const src = path.join(IMG_SRC, file);
      const dst = path.join(IMG_DST, file);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        copied++;
      }
    }
    if (copied) console.log(`[db] copied ${copied} images -> ${IMG_DST}`);
  }

  if (!fs.existsSync(SEED_PATH)) {
    console.error(`[db] seed file missing: ${SEED_PATH} (run extract/extract.py first)`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const deletedPinIds = new Set(
    db.prepare('SELECT pin_id FROM deleted_pins').all().map((row) => row.pin_id));
  const deletedUserIds = new Set(
    db.prepare('SELECT user_id FROM deleted_users').all().map((row) => row.user_id));

  const insertUser = db.prepare(`
    INSERT INTO users (id, username, full_name, first_name, image_medium, image_small,
      image_large, image_xlarge, about, country, follower_count, following_count,
      board_count, pin_count, is_me, raw_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      username=excluded.username, full_name=excluded.full_name,
      first_name=excluded.first_name, image_medium=excluded.image_medium,
      image_small=excluded.image_small, image_large=excluded.image_large,
      image_xlarge=excluded.image_xlarge, about=excluded.about,
      country=excluded.country, board_count=excluded.board_count,
      pin_count=excluded.pin_count, is_me=excluded.is_me,
      raw_json=excluded.raw_json`);

  const insertBoard = db.prepare(`
    INSERT INTO boards (id, user_id, name, url, pin_count, cover_url, image_cover_url,
      image_thumbnail_url, cover_images_json, collaborator_count, is_collaborative,
      board_order_modified_at, description, raw_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      user_id=excluded.user_id, name=excluded.name, url=excluded.url,
      pin_count=excluded.pin_count, cover_url=excluded.cover_url,
      image_cover_url=excluded.image_cover_url,
      image_thumbnail_url=excluded.image_thumbnail_url,
      cover_images_json=excluded.cover_images_json,
      collaborator_count=excluded.collaborator_count,
      is_collaborative=excluded.is_collaborative,
      board_order_modified_at=excluded.board_order_modified_at,
      description=excluded.description, raw_json=excluded.raw_json`);

  const insertPin = db.prepare(`
    INSERT INTO pins (id, title, description, dominant_color, created_at, is_video,
      link, domain, image_sig, img_url, img_width, img_height, images_json,
      repin_count, comment_count, board_id, pinner_id, creator_id, feed_rank,
      reaction_counts_json, link_domain_json, image_crop_json,
      recommendation_reason_json, raw_json, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, description=excluded.description,
      dominant_color=excluded.dominant_color, created_at=excluded.created_at,
      is_video=excluded.is_video, link=excluded.link, domain=excluded.domain,
      image_sig=excluded.image_sig, img_url=excluded.img_url,
      img_width=excluded.img_width, img_height=excluded.img_height,
      images_json=excluded.images_json, repin_count=excluded.repin_count,
      comment_count=excluded.comment_count, board_id=excluded.board_id,
      pinner_id=excluded.pinner_id, creator_id=excluded.creator_id,
      feed_rank=excluded.feed_rank,
      reaction_counts_json=excluded.reaction_counts_json,
      link_domain_json=excluded.link_domain_json,
      image_crop_json=excluded.image_crop_json,
      recommendation_reason_json=excluded.recommendation_reason_json,
      raw_json=excluded.raw_json, source=excluded.source`);

  const profile = data.user_profile || {};
  const meId = profile.id && !deletedUserIds.has(String(profile.id))
    ? String(profile.id)
    : null;

  db.exec('BEGIN');
  try {
    // Exactly one "me" account.
    db.exec('UPDATE users SET is_me = 0');

    for (const user of Object.values(data.users || {})) {
      if (!user?.id) continue;
      if (deletedUserIds.has(String(user.id))) continue;
      insertUser.run(
        String(user.id), user.username || `user${user.id}`, user.full_name || '',
        user.first_name || null, localImage(user.image_medium_url),
        localImage(user.image_small_url), localImage(user.image_large_url),
        localImage(user.image_xlarge_url), user.about || '', user.country || null,
        user.follower_count ?? null, user.following_count ?? null,
        user.board_count ?? null, user.pin_count ?? null,
        0,
        user.raw ? JSON.stringify(user.raw) : null,
      );
    }

    for (const board of Object.values(data.boards || {})) {
      if (!board?.id) continue;
      if (board.owner_id && deletedUserIds.has(String(board.owner_id))) continue;
      const cover = localImage(board.image_cover_hd_url) ||
        localImage(board.image_cover_url);
      insertBoard.run(
        String(board.id), board.owner_id ? String(board.owner_id) : null,
        board.name || 'Untitled board', board.url || null, board.pin_count || 0,
        cover, localImage(board.image_cover_url),
        localImage(board.image_thumbnail_url),
        board.raw?.cover_images ? JSON.stringify(board.raw.cover_images) : null,
        board.collaborator_count || 0, board.is_collaborative ? 1 : 0,
        board.board_order_modified_at || null, board.raw?.description || null,
        board.raw ? JSON.stringify(board.raw) : null,
      );
    }

    // The fallback board Pinterest creates for every account.  It stays after
    // the profile board so BoardsResource page_size=1 matches the HAR.
    if (meId) {
      insertBoard.run(
        QUICK_SAVES_ID, meId, 'Quick saves',
        `/${profile.username || 'me'}/quick-saves/`, 0, null, null, null, null,
        0, 0, null, 'Pins you save without picking a board.', null,
      );
    }

    const feedRank = new Map(
      (data.feed_order || []).map((pinId, index) => [String(pinId), index]));
    let pinCount = 0;
    for (const pin of Object.values(data.pins || {})) {
      if (!pin?.id) continue;
      if (deletedPinIds.has(String(pin.id))) continue;
      if (pin.pinner_id && deletedUserIds.has(String(pin.pinner_id))) continue;
      const images = pin.images || {};
      const best = bestImage(images);
      insertPin.run(
        String(pin.id), pin.title || '', pin.description || '',
        pin.dominant_color || null, pin.created_at || null,
        pin.is_video ? 1 : 0, pin.link || null, pin.domain || null,
        pin.image_signature || null, best?.url || null,
        best?.width || null, best?.height || null,
        Object.keys(images).length ? JSON.stringify(images) : null,
        pin.repin_count || 0, pin.comment_count || 0,
        pin.board_id ? String(pin.board_id) : null,
        pin.pinner_id ? String(pin.pinner_id) : null,
        pin.native_creator_id ? String(pin.native_creator_id) : null,
        feedRank.get(String(pin.id)) ?? null,
        JSON.stringify(pin.reaction_counts || {}),
        pin.raw?.link_domain ? JSON.stringify(pin.raw.link_domain) : null,
        pin.raw?.image_crop ? JSON.stringify(pin.raw.image_crop) : null,
        pin.raw?.recommendation_reason
          ? JSON.stringify(pin.raw.recommendation_reason) : null,
        pin.raw ? JSON.stringify(pin.raw) : null,
        pin.source || 'har',
      );
      pinCount++;
    }

    // Earlier builds synthesised minimal "image-only" filler pins from images
    // that no JSON response described. They are no longer part of the seed;
    // drop them from databases created before this change.
    db.exec(`DELETE FROM comments WHERE pin_id IN (
      SELECT id FROM pins WHERE source = 'image-only')`);
    db.exec(`DELETE FROM reactions WHERE pin_id IN (
      SELECT id FROM pins WHERE source = 'image-only')`);
    db.exec(`DELETE FROM saved WHERE pin_id IN (
      SELECT id FROM pins WHERE source = 'image-only')`);
    db.exec(`DELETE FROM pins WHERE source = 'image-only'`);

    // Keep Pins deleted by an admin deleted even though seed() re-upserts the
    // captured feed on every startup.
    db.exec(`DELETE FROM comments WHERE pin_id IN (
      SELECT pin_id FROM deleted_pins)`);
    db.exec(`DELETE FROM reactions WHERE pin_id IN (
      SELECT pin_id FROM deleted_pins)`);
    db.exec(`DELETE FROM saved WHERE pin_id IN (
      SELECT pin_id FROM deleted_pins)`);
    db.exec(`DELETE FROM pins WHERE id IN (
      SELECT pin_id FROM deleted_pins)`);

    // Likewise for accounts removed through the admin panel.
    db.exec(`DELETE FROM comments WHERE user_id IN (
      SELECT user_id FROM deleted_users)`);
    db.exec(`DELETE FROM reactions WHERE user_id IN (
      SELECT user_id FROM deleted_users)`);
    db.exec(`DELETE FROM saved WHERE user_id IN (
      SELECT user_id FROM deleted_users)`);
    db.exec(`DELETE FROM warnings WHERE user_id IN (
      SELECT user_id FROM deleted_users)`);
    db.exec(`DELETE FROM sessions WHERE user_id IN (
      SELECT user_id FROM deleted_users)`);
    db.exec(`DELETE FROM pins WHERE pinner_id IN (
      SELECT user_id FROM deleted_users)`);
    db.exec(`DELETE FROM boards WHERE user_id IN (
      SELECT user_id FROM deleted_users)`);
    db.exec(`DELETE FROM users WHERE id IN (
      SELECT user_id FROM deleted_users)`);

    const meta = db.prepare(`
      INSERT INTO meta (key, value) VALUES ('seed_version', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    meta.run(String(data.version || 1));

    db.exec('COMMIT');
    console.log(`[db] seeded ${pinCount} pins, ` +
      `${Object.keys(data.boards || {}).length} boards, ` +
      `${Object.keys(data.users || {}).length} users (v${data.version || 1})`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

migrate();
if (process.argv.includes('--seed')) seed();
