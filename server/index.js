// Tseretnip - Express server serving the /resource/ API + static frontend.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seed } from './db.js';
import { getSessionUser } from './auth.js';
import { envelope, parseData, handlers } from './routes/resources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

seed();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use((req, _res, next) => {
  req.user = getSessionUser(req);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// App pages. The shell is shared, but each view has its own URL so it works
// on reload, direct navigation, and the browser's back/forward buttons.
const APP_PAGES = [
  '/explore', '/profile', '/search',
  '/admin', '/admin/accounts', '/admin/pins', '/admin/posts', '/admin/log',
];
app.get(APP_PAGES, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
