#!/usr/bin/env node
// Compare live /resource/ responses with the original HAR capture.
//
//   node verify.js
//
// The script starts its own server on port 4100 with a throw-away SQLite file,
// compares field names for the resources that were actually captured, then
// exercises the write endpoints and restarts the server to prove persistence.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HAR_PATH = path.join(ROOT, 'updatedpinteresthar.har');
const PORT = 4100;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = '/tmp/opencode/pinterest-verify.db';
let sessionCookie = '';

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function readHar() {
  const har = JSON.parse(fs.readFileSync(HAR_PATH, 'utf8'));
  return har.log.entries
    .map((entry, index) => {
      const body = entry.response?.content?.text;
      if (!body || !entry.response.content.mimeType?.includes('json')) return null;
      try {
        const document = JSON.parse(body);
        return {
          index,
          document,
          name: document.resource?.name,
          options: document.resource?.options || {},
          response: document.resource_response || {},
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function harEntry(entries, name, predicate = () => true) {
  return entries.find((entry) => entry.name === name && predicate(entry));
}

function diffShapes(expected, actual, location = 'data', out = []) {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length && actual.length) {
      diffShapes(expected[0], actual[0], `${location}[0]`, out);
    }
    return out;
  }
  if (isObject(expected) && isObject(actual)) {
    // Entity ids are randomized in the anonymized seed, so two keys that
    // differ only in a 15-20 digit run (GET:v3/users/<id>/, session account
    // ids) name the same field.  Pair those instead of reporting them.
    const canonKey = (k) => k.replace(/\d{15,20}/g, '<id>');
    const canon = new Map();
    for (const key of Object.keys(actual)) canon.set(canonKey(key), key);
    const paired = new Map(); // expected key -> matching actual key
    for (const key of Object.keys(expected)) {
      if (key in actual) { paired.set(key, key); continue; }
      const hit = canon.get(canonKey(key));
      if (hit !== undefined && !(hit in expected)) paired.set(key, hit);
    }
    const pairedActual = new Set(paired.values());
    for (const key of Object.keys(expected)) {
      if (!paired.has(key)) out.push(`missing ${location}.${key}`);
    }
    for (const key of Object.keys(actual)) {
      if (!pairedActual.has(key)) out.push(`extra   ${location}.${key}`);
    }
    for (const [expectedKey, actualKey] of paired) {
      diffShapes(expected[expectedKey], actual[actualKey], `${location}.${expectedKey}`, out);
    }
  }
  return out;
}

async function fetchJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (sessionCookie) headers.Cookie = sessionCookie;
  const response = await fetch(url, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';')[0];
  return { status: response.status, json: await response.json() };
}

function encodeData(options) {
  return encodeURIComponent(JSON.stringify({ options, context: {} }));
}

async function resourceGet(name, options) {
  return fetchJson(
    `${BASE}/resource/${name}/get/?source_url=%2F&data=${encodeData(options)}`);
}

async function resourcePost(name, verb, options) {
  return fetchJson(`${BASE}/resource/${name}/${verb}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `source_url=%2F&data=${encodeData(options)}`,
  });
}

function startServer() {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DB_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`  [server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`  [server] ${chunk}`));
  return child;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

async function main() {
  if (!fs.existsSync(HAR_PATH)) {
    console.error(`HAR not found: ${HAR_PATH}`);
    process.exit(1);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }

  const entries = readHar();
  console.log(`[verify] HAR entries with JSON: ${entries.length}`);
  console.log(`[verify] starting server with ${DB_PATH}`);

  let server = startServer();
  let failures = 0;
  try {
    await waitForServer();

    // The instance has no default account.  Create a throw-away account so the
    // authenticated checks below exercise the same path as the frontend.
    const signup = await resourcePost('UserSessionResource', 'create', {
      mode: 'signup',
      full_name: 'Verify User',
      username: 'verifyuser',
      email: 'verify@example.local',
      password: 'verify-pass-123',
    });
    if (signup.status !== 200 ||
        !signup.json.resource_response.data?.authenticated) {
      throw new Error('could not create verification account');
    }

    const checks = [
      {
        label: 'UserHomefeedResource (hf_grid)',
        name: 'UserHomefeedResource',
        har: harEntry(entries, 'UserHomefeedResource'),
        live: () => resourceGet('UserHomefeedResource', {
          field_set_key: 'hf_grid', in_nux: false, in_news_hub: false,
          static_feed: false, bookmarks: [],
        }),
      },
      {
        label: 'BoardsResource (profile, page_size=1)',
        name: 'BoardsResource',
        har: harEntry(entries, 'BoardsResource'),
        live: () => resourceGet('BoardsResource', {
          page_size: 1, privacy_filter: 'all', sort: 'last_pinned_to',
          username: 'thistlebay',
        }),
      },
      {
        label: 'UserResource (profile)',
        name: 'UserResource',
        har: harEntry(entries, 'UserResource',
          (entry) => entry.options.field_set_key === 'profile'),
        live: () => resourceGet('UserResource', {
          field_set_key: 'profile', username: 'thistlebay',
        }),
      },
      {
        label: 'UserResource (save_behavior)',
        name: 'UserResource',
        har: harEntry(entries, 'UserResource',
          (entry) => entry.options.field_set_key === 'save_behavior'),
        live: () => resourceGet('UserResource', {
          field_set_key: 'save_behavior', user_id: '8298501452116908277',
        }),
      },
      {
        label: 'AdvancedTypeaheadResource (empty term)',
        name: 'AdvancedTypeaheadResource',
        har: harEntry(entries, 'AdvancedTypeaheadResource'),
        live: () => resourceGet('AdvancedTypeaheadResource', {
          term: '', pin_scope: 'pins', autocomplete_request_surface: 0,
        }),
      },
      {
        label: 'SearchTabResource (empty)',
        name: 'SearchTabResource',
        har: harEntry(entries, 'SearchTabResource'),
        live: () => resourceGet('SearchTabResource', {}),
      },
      {
        label: 'ConversationsResource',
        name: 'ConversationsResource',
        har: harEntry(entries, 'ConversationsResource'),
        live: () => resourceGet('ConversationsResource', {}),
      },
      {
        label: 'NewsHubBadgeResource',
        name: 'NewsHubBadgeResource',
        har: harEntry(entries, 'NewsHubBadgeResource'),
        live: () => resourceGet('NewsHubBadgeResource', {}),
      },
      {
        label: 'UserExperiencePlatformResource',
        name: 'UserExperiencePlatformResource',
        har: harEntry(entries, 'UserExperiencePlatformResource'),
        live: () => resourceGet('UserExperiencePlatformResource', {
          extra_context: { eml_pin_closeup_web: 'enabled' },
        }),
      },
      {
        label: 'UserExperienceResource',
        name: 'UserExperienceResource',
        har: harEntry(entries, 'UserExperienceResource'),
        live: () => resourceGet('UserExperienceResource', {
          placement_ids: [11],
          extra_context: { using_pwa: false, eml_pin_closeup_web: 'enabled' },
        }),
      },
      {
        label: 'ApiResource /v3/users/me/',
        name: 'ApiResource',
        har: harEntry(entries, 'ApiResource',
          (entry) => entry.options.url === '/v3/users/me/'),
        live: () => resourceGet('ApiResource', {
          url: '/v3/users/me/',
          data: { fields: ['user.full_name', 'user.email'] },
        }),
      },
      {
        label: 'ApiResource /v3/users/<name>/metadata/',
        name: 'ApiResource',
        har: harEntry(entries, 'ApiResource',
          (entry) => entry.options.url === '/v3/users/thistlebay/metadata/'),
        live: () => resourceGet('ApiResource', {
          url: '/v3/users/thistlebay/metadata/', data: {},
        }),
      },
      {
        label: 'ApiResource /v3/search/ghost_queries/',
        name: 'ApiResource',
        har: harEntry(entries, 'ApiResource',
          (entry) => entry.options.url === '/v3/search/ghost_queries/'),
        live: () => resourceGet('ApiResource', {
          url: '/v3/search/ghost_queries/', data: {},
        }),
      },
      {
        label: 'ApiResource /v3/users/settings/gen_ai/',
        name: 'ApiResource',
        har: harEntry(entries, 'ApiResource',
          (entry) => entry.options.url === '/v3/users/settings/gen_ai/'),
        live: () => resourceGet('ApiResource', {
          url: '/v3/users/settings/gen_ai/', data: {},
        }),
      },
      {
        label: 'ApiResource /v3/batch/ (create)',
        name: 'ApiResource',
        har: harEntry(entries, 'ApiResource',
          (entry) => entry.options.url === '/v3/batch/'),
        live: () => resourcePost('ApiResource', 'create', {
          url: '/v3/batch/',
          data: {
            requests: JSON.stringify([
              { uri: 'v3/users/8298501452116908277/', method: 'GET' },
            ]),
          },
        }),
      },
      {
        label: 'UserSessionResource (create)',
        name: 'UserSessionResource',
        har: harEntry(entries, 'UserSessionResource'),
        live: () => resourcePost('UserSessionResource', 'create', {
          session_accounts: true,
        }),
      },
      {
        label: 'ActivateExperimentResource (create)',
        name: 'ActivateExperimentResource',
        har: harEntry(entries, 'ActivateExperimentResource'),
        live: () => resourcePost('ActivateExperimentResource', 'create', {
          experiments: [
            { experiment_name: 'demo', experiment_group: 'enabled' },
          ],
        }),
      },
    ];

    for (const check of checks) {
      if (!check.har) {
        console.log(`\n[skip] ${check.label} - not in HAR`);
        continue;
      }
      const live = await check.live();
      if (live.status !== 200) {
        failures++;
        console.log(`\n[FAIL] ${check.label} - HTTP ${live.status}`);
        continue;
      }
      const expected = check.har.response;
      const actual = live.json.resource_response;
      const envelopeDiff = diffShapes(expected, actual, 'resource_response');
      const dataDiff = diffShapes(expected.data, actual.data, 'data');
      // The extractor deliberately strips tracking/secret keys, so their
      // absence from live responses is expected.
      const ignored = /(tracking|token|cookie|password|recaptcha|fingerprint|\.email$)/i;
      const missing = [...envelopeDiff, ...dataDiff]
        .filter((line) => line.startsWith('missing') && !ignored.test(line));
      const extras = [...envelopeDiff, ...dataDiff]
        .filter((line) => line.startsWith('extra'));
      const status = missing.length ? 'FAIL' : 'ok';
      if (missing.length) failures++;
      console.log(`\n[${status}] ${check.label}`);
      console.log(`  envelope: ${Object.keys(actual).join(', ')}`);
      if (missing.length) {
        console.log('  missing fields:');
        for (const line of missing.slice(0, 12)) console.log(`    ${line}`);
      }
      if (extras.length) {
        console.log(`  extra fields (live-only): ${extras.length}`);
        for (const line of extras.slice(0, 6)) console.log(`    ${line}`);
      }
    }

    // ---- write endpoints + persistence across a restart -------------------
    console.log('\n[verify] write endpoints');
    const feed = await resourceGet('UserHomefeedResource', {
      field_set_key: 'hf_grid', bookmarks: [],
    });
    const pin = feed.json.resource_response.data[0];
    const boards = await resourceGet('BoardsResource', {
      page_size: 100, username: 'me',
    });
    const board = boards.json.resource_response.data[0];
    const before = pin.reaction_counts?.['1'] || 0;

    const save = await resourcePost('ApiResource', 'create', {
      url: `/v3/board/${board.id}/pin/${pin.id}/save/`, data: {},
    });
    const react = await resourcePost('ApiResource', 'update', {
      url: `/v3/pins/${pin.id}/reaction/`, data: { reaction: 1 },
    });
    if (!save.json.resource_response.data.saved) {
      failures++;
      console.log('  [FAIL] save did not report saved=true');
    } else {
      console.log(`  [ok] saved pin ${pin.id} to board ${board.id}`);
    }
    if (!react.json.resource_response.data.reacted) {
      failures++;
      console.log('  [FAIL] reaction did not report reacted=true');
    } else {
      console.log(`  [ok] reacted to pin ${pin.id}`);
    }

    console.log('[verify] restarting server to check SQLite persistence...');
    await stopServer(server);
    server = startServer();
    await waitForServer();

    const after = await resourceGet('PinResource', {
      id: pin.id, field_set_key: 'auth_web_main_pin',
    });
    const savedInfo = after.json.resource_response.data.saved_info;
    const afterCount = after.json.resource_response.data.reaction_counts?.['1'] || 0;
    if (!savedInfo.saved) {
      failures++;
      console.log('  [FAIL] saved state did not survive restart');
    } else {
      console.log('  [ok] saved state survived restart');
    }
    if (!savedInfo.reacted) {
      failures++;
      console.log('  [FAIL] reaction state did not survive restart');
    } else {
      console.log(`  [ok] reaction state survived restart (${before} -> ${afterCount})`);
    }
  } finally {
    await stopServer(server);
  }

  console.log(`\n[verify] ${failures === 0 ? 'PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
