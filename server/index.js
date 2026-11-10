// Tseretnip - Express server serving the /resource/ API + static frontend.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seed } from './db.js';
import { getSessionUser } from './auth.js';
import { envelope, parseData, handlers } from './routes/resources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

seed();

const app = express();
// Image uploads are capped at 8 MB after base64 decoding, which is ~11 MB on
// the wire once URL-encoded inside the `data` field.
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));
app.use((req, _res, next) => {
  req.user = getSessionUser(req);
  next();
});
// App pages. The shell is shared, but each view has its own URL so it works
// on reload, direct navigation, and the browser's back/forward buttons.
const APP_PAGES = [
  '/explore', '/profile', '/search',
  '/admin', '/admin/accounts', '/admin/pins', '/admin/posts', '/admin/log',
];

// --- link embeds (Discord & friends read og:/twitter: meta, not JS) ---
const PUBLIC_DIR = path.join(__dirname, 'public');

// Content-hash the frontend assets and append it as a query string.  Proxies
// (Cloudflare in particular) can force a long browser cache on .js/.css, so a
// plain reload after a deploy may keep running the old bundle.  A new hash
// changes the URL and busts that cache automatically.
const ASSET_VERSION = (() => {
  const hash = crypto.createHash('sha1');
  for (const file of ['app.js', 'style.css']) {
    hash.update(fs.readFileSync(path.join(PUBLIC_DIR, file)));
  }
  return hash.digest('hex').slice(0, 10);
})();

const SHELL = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace('href="style.css"', `href="style.css?v=${ASSET_VERSION}"`)
  .replace('src="app.js"', `src="app.js?v=${ASSET_VERSION}"`);
const pinForEmbed = db.prepare(
  'SELECT id, title, description, img_url FROM pins WHERE id = ?');

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function embedMeta(req, pin) {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const base = `${proto}://${host}`;
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  let title = 'Tseretnip';
  let description = 'A self-hosted, Pinterest-compatible pin-board instance.';
  let image = '/assets/logo.jpg';
  let card = 'summary';
  if (pin) {
    title = clean(pin.title || pin.description).slice(0, 120) || 'Pin on Tseretnip';
    description = clean(pin.description || pin.title).slice(0, 200)
      || 'Discovered on Tseretnip';
    if (pin.img_url) image = pin.img_url;
    card = 'summary_large_image';
  }

  const tags = [
    ['og:site_name', 'Tseretnip'],
    ['og:type', 'website'],
    ['og:title', title],
    ['og:description', description],
    ['og:url', base + req.originalUrl],
    ['og:image', base + image],
    ['twitter:card', card],
    ['twitter:title', title],
    ['twitter:description', description],
    ['twitter:image', base + image],
  ];
  return tags.map(([property, content]) =>
    `<meta property="${property}" content="${escapeAttr(content)}">`).join('\n  ');
}

// Serves the app shell with per-URL embed meta.  A `?pin=<id>` link (the
// shareable closeup) gets that pin's title/description/image in the card.
function serveShell(req, res) {
  const pinId = req.query.pin;
  const pin = pinId ? pinForEmbed.get(String(pinId)) : null;
  const html = SHELL.replace('<!-- embed -->', embedMeta(req, pin));
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Always revalidate the shell so a deploy is picked up on the next load.
  res.set('Cache-Control', 'no-cache');
  res.send(html);
}

// The shell routes must win over express.static, which would otherwise
// answer `/` with the raw file (no embed meta).
app.get('/', serveShell);
app.get(APP_PAGES, serveShell);

app.use(express.static(path.join(__dirname, 'public')));

// Profile URLs (`/<username>/`) fall through static and render the app shell.
// The frontend router then loads that user's profile.
const RESERVED_PATHS = new Set(['favicon.ico', 'robots.txt', 'health']);
app.get('/:username', (req, res, next) => {
  if (RESERVED_PATHS.has(req.params.username)) return next();
  serveShell(req, res);
});

// The universal resource route: GET/POST /resource/<Name>/<verb>/
app.all(['/resource/:name/:verb', '/resource/:name/:verb/'], (req, res) => {
  const { name, verb } = req.params;
  const handler = handlers[name];
  if (!handler || !handler[verb] || !['get', 'create', 'update'].includes(verb)) {
    return res.status(404).json(envelope(
      { name, options: {} }, null,
      { simple: true, status: 'error', http_status: 404, message: 'Not found' }));
  }
  try {
    const body = parseData(req);
    const result = handler[verb](body, { req, res });
    const { data, httpStatus, ...extra } = result;
    return res.status(httpStatus || 200).json(envelope(
      { name, options: body.options || {} }, data, extra));
  } catch (error) {
    console.error(`[resource:${name}.${verb}]`, error);
    return res.status(500).json(envelope(
      { name, options: {} }, null,
      { simple: true, status: 'error', http_status: 500, message: String(error) }));
  }
});

app.get('/health', (_req, res) => {
  const pins = db.prepare('SELECT COUNT(*) AS n FROM pins').get().n;
  res.json({ ok: true, pins, service: 'tseretnip' });
});

app.listen(PORT, () => {
  console.log(`[server] Tseretnip listening on http://localhost:${PORT}`);
});
