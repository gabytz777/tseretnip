// Account + session helpers for the instance's own signup/login flow.
//
// Pinterest's captured UserSessionResource is reused as the transport:
//   POST /resource/UserSessionResource/create/  { mode: 'login' | 'signup' }
//   GET  /resource/UserSessionResource/get/     current session
//   POST /resource/UserSessionResource/update/  { action: 'logout' }
//
// Passwords are hashed with scrypt and sessions live in SQLite.  The captured
// HAR account is just seed content; it is never the logged-in user.
import crypto from 'node:crypto';
import { db } from './db.js';

export const SESSION_COOKIE = 'pr_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export function getSessionUser(req) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!token) return null;
  return db.prepare(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND COALESCE(u.is_banned, 0) = 0`).get(token) || null;
}

export function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, String(userId), new Date().toISOString());
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; ` +
    `SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`);
  return token;
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; ` +
    'SameSite=Lax; Max-Age=0');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Password handed to an admin after a reset.  10 characters from an alphabet
// without look-alike glyphs (0/O, 1/l/I) so it is easy to read aloud or retype.
export function randomPassword(length = 10) {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < length; i += 1) {
    password += alphabet[crypto.randomInt(alphabet.length)];
  }
  return password;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(
      String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function findUserByIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  return db.prepare(
    `SELECT * FROM users
     WHERE lower(username) = lower(?) OR lower(email) = lower(?)
     LIMIT 1`).get(value, value) || null;
}

export function createAccount({ fullName, username, email, password } = {}) {
  const name = String(fullName || '').trim();
  const handle = String(username || '').trim().toLowerCase();
  const mail = String(email || '').trim().toLowerCase();
  const pass = String(password || '');

  if (name.length < 1 || name.length > 60) {
    throw new AuthError('Please enter your name.');
  }
  if (!/^[a-z0-9_.]{3,30}$/.test(handle)) {
    throw new AuthError(
      'Username must be 3–30 characters using letters, numbers, dots, or underscores.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    throw new AuthError('Please enter a valid email address.');
  }
  if (pass.length < 8) {
    throw new AuthError('Password must be at least 8 characters.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE lower(username) = lower(?)')
    .get(handle)) {
    throw new AuthError('That username is already taken.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?)').get(mail)) {
    throw new AuthError('An account with that email already exists.');
  }

  const id = String(Date.now()) + String(crypto.randomInt(100, 1000));
  const now = new Date().toISOString();
  const isFirstAccount = !db.prepare(
    'SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1').get();

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO users (id, username, full_name, first_name, email, password_hash,
        image_medium, image_small, image_large, image_xlarge, about, country,
        follower_count, following_count, board_count, pin_count, is_me,
        is_admin, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`)
      .run(
        id, handle, name, name.split(/\s+/)[0] || name, mail, hashPassword(pass),
        null, null, null, null, '', null, 0, 0, 1, 0, isFirstAccount ? 1 : 0,
      );

    db.prepare(`
      INSERT INTO boards (id, user_id, name, url, pin_count, cover_url,
        image_cover_url, image_thumbnail_url, cover_images_json,
        collaborator_count, is_collaborative, board_order_modified_at,
        description, raw_json)
      VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, 0, 0, ?, ?, NULL)`)
      .run(
        `quick-${id}`, id, 'Quick saves', `/${handle}/quick-saves/`, now,
        'Pins you save without picking a board.',
      );

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function login({ identifier, password } = {}) {
  const user = findUserByIdentifier(identifier);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new AuthError('Invalid username or password.', 401);
  }
  if (user.is_banned) {
    const reason = user.ban_reason ? ` Reason: ${user.ban_reason}` : '';
    throw new AuthError(`This account has been banned.${reason}`, 403);
  }
  return user;
}
