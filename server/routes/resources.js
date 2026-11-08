// /resource/<Name>/<verb>/ dispatcher - mirrors the routing pattern observed in
// the HAR: GET/POST with a `data` query/body param carrying {options, context}.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import {
  createAccount, login, createSession, destroySession, AuthError,
  hashPassword, randomPassword,
} from '../auth.js';
import {
  makeBookmark, parseBookmark, pinShape, previewPinShape, boardShape,
  userShape, nodeId, b64, pinImages,
} from '../shapes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.resolve(__dirname, '../../extract/seed.json');
const UPLOAD_DIR = path.resolve(__dirname, '../public/uploads');
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const STATIC_SEED = fs.existsSync(SEED_PATH)
  ? JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'))
  : {};

const getPin = db.prepare('SELECT * FROM pins WHERE id = ?');
const getBoard = db.prepare('SELECT * FROM boards WHERE id = ?');
const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const getUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const pinsOrdered = db.prepare(
  `SELECT * FROM pins
   ORDER BY feed_rank IS NULL, feed_rank, created_at DESC, id`);
const boardsOf = db.prepare(
  'SELECT * FROM boards WHERE user_id = ? ORDER BY rowid');
const searchPins = db.prepare(
  `SELECT p.* FROM pins p LEFT JOIN boards b ON b.id = p.board_id
   WHERE lower(p.title) LIKE ? OR lower(p.description) LIKE ?
      OR lower(coalesce(p.domain,'')) LIKE ? OR lower(coalesce(b.name,'')) LIKE ?
   ORDER BY p.repin_count DESC, p.feed_rank LIMIT 50`);

// ---- shared envelope -------------------------------------------------------
function envelope(resource, data, extra = {}) {
  const { simple = false, ...responseExtra } = extra;
  const endpointName = responseExtra.endpoint_name;
  const resourceResponse = simple
    ? { status: 'success', http_status: 200, data, ...responseExtra }
    : {
      status: 'success',
      code: 0,
      message: 'ok',
      endpoint_name: endpointName,
      data,
      ...responseExtra,
      x_pinterest_sli_endpoint_name: endpointName,
      http_status: 200,
    };
  return {
    resource_response: resourceResponse,
    client_context: {
      browser_name: 'Firefox',
      browser_version: '159.0',
      country: 'RO',
      country_from_hostname: 'RO',
      country_from_ip: 'RO',
      is_authenticated: true,
      is_bot: false,
      app_version: '9323214',
      app_type_detailed: 5,
    },
    resource,
    request_identifier: String(Math.floor(Math.random() * 2 ** 31)),
  };
}

function parseData(req) {
  let raw = req.query?.data;
  if (raw == null && req.body && typeof req.body === 'object') raw = req.body.data;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  if (raw && typeof raw === 'object') return raw;
  if (req.body && typeof req.body === 'object' && req.body.options) return req.body;
  return { options: {}, context: {} };
}

function pageOf(items, options, defaultSize = 24) {
  const size = Math.max(1, Number(options.page_size) || defaultSize);
  const offset = parseBookmark(
    Array.isArray(options.bookmarks) ? options.bookmarks[0] : options.bookmark) || 0;
  const page = items.slice(offset, offset + size);
  const next = offset + size < items.length ? offset + size : null;
  return { page, bookmark: makeBookmark(next) };
}

function meOf(ctx) {
  return ctx?.req?.user || null;
}

function findUser(options, ctx) {
  if (options.user_id) return getUser.get(String(options.user_id));
  const username = options.username;
  if (!username || username === 'me') return meOf(ctx);
  return getUserByName.get(username);
}

function sessionPayload(user) {
  if (!user) {
    return {
      authenticated: false,
      user: null,
      warnings: [],
      restriction: { restricted: false },
    };
  }
  const warnings = db.prepare(
    `SELECT id, message, created_at FROM warnings
     WHERE user_id = ? AND acknowledged_at IS NULL
     ORDER BY created_at DESC`).all(user.id);
  return {
    authenticated: true,
    user: userShape(user),
    warnings,
    restriction: user.is_restricted ? {
      restricted: true,
      reason: user.restrict_reason || '',
      since: user.restricted_at || null,
    } : { restricted: false },
  };
}

class ModerationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ModerationError';
    this.status = status;
  }
}

function adminGuard(ctx) {
  const me = meOf(ctx);
  if (!me) return { error: 'unauthorized', httpStatus: 401 };
  if (!me.is_admin) return { error: 'Admins only.', httpStatus: 403 };
  return null;
}

function logModeration(actor, action, { targetUser, targetPin, detail } = {}) {
  const id = `m_${Date.now()}_${crypto.randomInt(100, 1000)}`;
  db.prepare(`INSERT INTO moderation_log
      (id, actor_id, action, target_user_id, target_pin_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, actor?.id || null, action, targetUser?.id || null,
      targetPin?.id || null, detail || null, new Date().toISOString(),
    );
}

function assertModeratable(me, target) {
  if (target.id === me.id) {
    throw new ModerationError('You cannot moderate your own account.');
  }
  if (target.is_admin) {
    throw new ModerationError('Admin accounts are protected.');
  }
}

function removePin(pin) {
  db.prepare('DELETE FROM reactions WHERE pin_id = ?').run(pin.id);
  db.prepare('DELETE FROM saved WHERE pin_id = ?').run(pin.id);
  if (pin.source === 'created' && String(pin.img_url || '').startsWith('/uploads/')) {
    try {
      fs.rmSync(path.join(UPLOAD_DIR, path.basename(pin.img_url)), { force: true });
    } catch { /* best effort */ }
  }
  db.prepare('DELETE FROM pins WHERE id = ?').run(pin.id);
  if (pin.source !== 'created') {
    db.prepare(`INSERT OR IGNORE INTO deleted_pins (pin_id, deleted_at)
                VALUES (?, ?)`).run(pin.id, new Date().toISOString());
  }
  if (pin.board_id) recountBoard(pin.board_id);
  if (pin.source === 'created' && pin.pinner_id) {
    db.prepare(`UPDATE users SET pin_count = MAX(COALESCE(pin_count, 0) - 1, 0)
                WHERE id = ?`).run(pin.pinner_id);
  }
}

function removeAccount(target) {
  const ownedPins = db.prepare(
    'SELECT * FROM pins WHERE pinner_id = ?').all(target.id);
  const boardIds = db.prepare(
    'SELECT id FROM boards WHERE user_id = ?').all(target.id).map((row) => row.id);
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const pin of ownedPins) {
      db.prepare('DELETE FROM reactions WHERE pin_id = ?').run(pin.id);
      db.prepare('DELETE FROM saved WHERE pin_id = ?').run(pin.id);
      if (pin.source === 'created' && String(pin.img_url || '').startsWith('/uploads/')) {
        try {
          fs.rmSync(path.join(UPLOAD_DIR, path.basename(pin.img_url)), { force: true });
        } catch { /* best effort */ }
      }
      db.prepare('DELETE FROM pins WHERE id = ?').run(pin.id);
      if (pin.source !== 'created') {
        db.prepare(`INSERT OR IGNORE INTO deleted_pins (pin_id, deleted_at)
                    VALUES (?, ?)`).run(pin.id, now);
      }
    }
    db.prepare('DELETE FROM saved WHERE user_id = ?').run(target.id);
    if (boardIds.length) {
      const marks = boardIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM saved WHERE board_id IN (${marks})`).run(...boardIds);
    }
    db.prepare('DELETE FROM reactions WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR following_id = ?')
      .run(target.id, target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM warnings WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM boards WHERE user_id = ?').run(target.id);
    db.prepare(`INSERT OR IGNORE INTO deleted_users (user_id, deleted_at)
                VALUES (?, ?)`).run(target.id, now);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function moderationLog(limit = 200) {
  return db.prepare(`
    SELECT m.*, a.username AS actor_username, a.is_admin AS actor_is_admin,
           tu.username AS target_username,
           tp.title AS target_pin_title
    FROM moderation_log m
    LEFT JOIN users a ON a.id = m.actor_id
    LEFT JOIN users tu ON tu.id = m.target_user_id
    LEFT JOIN pins tp ON tp.id = m.target_pin_id
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT ?`).all(limit).map((row) => ({
    id: row.id,
    action: row.action,
    actor: row.actor_username || 'deleted account',
    actor_is_admin: Boolean(row.actor_is_admin),
    target_user: row.target_username || '',
    target_pin: row.target_pin_title || '',
    detail: row.detail || '',
    created_at: row.created_at,
  }));
}

// ---- resource handlers -----------------------------------------------------
const handlers = {
  UserHomefeedResource: {
    get({ options }, ctx) {
      const PAGE = 24;
      const all = pinsOrdered.all();
      const offset = parseBookmark(
        Array.isArray(options.bookmarks) ? options.bookmarks[0] : null) || 0;
      const page = all.slice(offset, offset + PAGE);
      const next = offset + PAGE < all.length ? offset + PAGE : null;
      return {
        data: page.map((pin) => pinShape(pin, {
          db, userId: meOf(ctx)?.id,
        })),
        bookmark: makeBookmark(next),
        endpoint_name: 'v3_home_feed',
      };
    },
  },

  UserResource: {
    get({ options }, ctx) {
      const user = findUser(options, ctx);
      if (!user) return { data: null, endpoint_name: 'v3_get_user_handler' };
      const fieldSet = options.field_set_key || 'profile';
      if (fieldSet === 'save_behavior') {
        return {
          data: {
            node_id: nodeId('User', user.id),
            save_behavior: 1,
            id: String(user.id),
          },
          endpoint_name: 'v3_get_user_handler',
        };
      }
      const shape = userShape(user);
      if (fieldSet === 'grid_item') {
        return { data: shape, endpoint_name: 'v3_get_user_handler' };
      }
      // Profile field set.  raw_json carries the captured profile fields;
      // overlay the live values we keep in SQLite.
      return {
        data: {
          ...shape,
          about: user.about || '',
          board_count: user.board_count ?? 0,
          country: user.country || 'RO',
          follower_count: user.follower_count ?? 0,
          following_count: user.following_count ?? 0,
          full_name: user.full_name || user.username,
          first_name: user.first_name || user.full_name,
          image_medium_url: shape.image_medium_url,
          image_large_url: shape.image_large_url,
          image_xlarge_url: shape.image_xlarge_url,
          pin_count: user.pin_count ?? 0,
          profile_tabs: ['boards'],
          type: 'user',
        },
        endpoint_name: 'v3_get_user_handler',
      };
    },
  },

  BoardsResource: {
    get({ options }, ctx) {
      const user = findUser(options, ctx);
      if (!user) return { data: [], bookmark: '-end-', endpoint_name: 'v3_user_profile_boards_feed' };
      const { page, bookmark } = pageOf(boardsOf.all(user.id), options, 25);
      return {
        data: page.map((board) => boardShape(board, { db })),
        bookmark,
        endpoint_name: 'v3_user_profile_boards_feed',
      };
    },
  },

  BoardFeedResource: {
    get({ options }, ctx) {
      let boardId = options.board_id || options.boardId || options.id;
      if (!boardId && options.username) {
        const user = findUser(options, ctx);
        const first = user ? boardsOf.get(user.id) : null;
        boardId = first?.id;
      }
      const board = boardId ? getBoard.get(String(boardId)) : null;
      if (!board) {
        return { data: [], bookmark: '-end-', endpoint_name: 'v3_board_feed' };
      }
      const pins = db.prepare(
        `SELECT p.* FROM pins p
         WHERE p.id IN (
           SELECT id FROM pins WHERE board_id = ?
           UNION
           SELECT pin_id FROM saved WHERE board_id = ?
         )
         ORDER BY p.feed_rank IS NULL, p.feed_rank, p.created_at DESC`).all(board.id, board.id);
      const { page, bookmark } = pageOf(pins, options, 24);
      return {
        data: page.map((pin) => pinShape(pin, {
          db, userId: meOf(ctx)?.id,
        })),
        bookmark,
        endpoint_name: 'v3_board_feed',
      };
    },
  },

  PinResource: {
    get({ options }, ctx) {
      const pin = getPin.get(String(options.id || options.pin_id || ''));
      if (!pin) return { data: null, endpoint_name: 'v3_pin' };
      return {
        data: pinShape(pin, {
          db, fieldSet: 'closeup', userId: meOf(ctx)?.id,
        }),
        endpoint_name: 'v3_pin',
      };
    },

    create({ options = {} }, ctx) {
      const me = meOf(ctx);
      if (!me) {
        return {
          data: null, error: 'unauthorized', httpStatus: 401,
          endpoint_name: 'v3_create_pin',
        };
      }
      if (me.is_restricted) {
        return {
          data: null,
          error: 'Your account is restricted from creating Pins.',
          httpStatus: 403,
          endpoint_name: 'v3_create_pin',
        };
      }
      try {
        const pin = createPin(options, me);
        return {
          data: pinShape(pin, {
            db, fieldSet: 'closeup', userId: me.id,
          }),
          endpoint_name: 'v3_create_pin',
        };
      } catch (error) {
        if (error instanceof PinError) {
          return {
            data: null, error: error.message, httpStatus: error.status,
            endpoint_name: 'v3_create_pin',
          };
        }
        throw error;
      }
    },
  },

  RelatedPinsResource: {
    get({ options }, ctx) {
      const excludeId = String(options.id || options.pin_id || '');
      const pin = excludeId ? getPin.get(excludeId) : null;
      let pins = pinsOrdered.all().filter((row) => row.id !== excludeId);
      if (pin) {
        // Prefer the same board/creator, then fall back to the rest of the feed.
        pins.sort((a, b) => {
          const score = (row) =>
            (row.board_id === pin.board_id ? 2 : 0) +
            (row.creator_id === pin.creator_id ? 1 : 0);
          return score(b) - score(a);
        });
      }
      const { page, bookmark } = pageOf(pins, options, 24);
      return {
        data: page.map((row) => pinShape(row, {
          db, userId: meOf(ctx)?.id,
        })),
        bookmark,
        endpoint_name: 'v3_related_pins',
      };
    },
  },

  SearchTabResource: {
    get({ options }, ctx) {
      const term = String(
        options.term || options.query || options.q || options.data?.query || '').trim();
      if (!term) {
        return {
          data: STATIC_SEED.search_tab || [],
          endpoint_name: 'v3_search_tab_handler',
        };
      }
      const pins = searchPins.all(...Array(4).fill(`%${term.toLowerCase()}%`));
      const { page, bookmark } = pageOf(pins, options, 24);
      const story = {
        description: null,
        mapped_display_options: {},
        id: `search_${b64(term).replace(/[^a-z0-9]/gi, '').slice(0, 8)}`,
        subtitle: null,
        type: 'story',
        title: { args_reformatted: [], format: term, args: [], text: null },
        container_type: 56,
        bookmarks_for_objects: bookmark,
        seo_board_module: null,
        action: {},
        background_colour: null,
        expanded_viewport_objects: [],
        item_actions: [],
        custom_properties: {},
        copy: {},
        aux_fields: {},
        user: null,
        slot: null,
        story_type: 'BUBBLE_ONE_COL',
        content_ids: page.map((pin) => pin.id),
        items: page.map((pin) => pinShape(pin, {
          db, userId: meOf(ctx)?.id,
        })),
        objects: page.map((pin) => pinShape(pin, {
          db, userId: meOf(ctx)?.id,
        })),
      };
      return {
        data: [story],
        bookmark,
        endpoint_name: 'v3_search_tab_handler',
      };
    },
  },

  AdvancedTypeaheadResource: {
    get({ options }) {
      const term = String(options.term || '').trim();
      if (!term) {
        return {
          data: { items: STATIC_SEED.typeahead_items || [] },
          endpoint_name: 'v3_autocomplete_handler',
        };
      }
      const items = [];
      const lower = term.toLowerCase();
      for (const pin of searchPins.all(...Array(4).fill(`%${lower}%`)).slice(0, 8)) {
        const link = `/search/pins/?q=${encodeURIComponent(term)}` +
          `&rs=rs&source_id=rs_${b64(pin.id).slice(0, 8)}&top_pin_ids=${pin.id}`;
        const images = JSON.parse(pin.images_json || '{}');
        items.push({
          display_query: null,
          vertical: 'pins',
          link,
          vase_event_type: null,
          vase_image_signature: null,
          vase_timestamp: null,
          tag: 'suggestion',
          identifier_icon_name: null,
          vase_pin_id: String(pin.id),
          query: term,
          id: `rs_${b64(pin.id).replace(/[^a-z0-9]/gi, '').slice(0, 8)}`,
          type: 'suggestion',
          label: (pin.title || pin.description || '').trim() || term,
          url: link,
          image: images['236x']?.url || '',
          image_preview_pins: [previewPinShape(pin)],
        });
      }
      for (const user of db.prepare(
        'SELECT * FROM users WHERE lower(username) LIKE ? LIMIT 3')
        .all(`%${lower}%`)) {
        const shape = userShape(user);
        items.push({
          display_query: null,
          vertical: 'users',
          link: `/${user.username}/`,
          vase_event_type: null,
          vase_image_signature: null,
          vase_timestamp: null,
          tag: 'suggestion',
          identifier_icon_name: null,
          vase_pin_id: null,
          query: user.username,
          id: `us_${user.id}`,
          type: 'user',
          label: user.full_name || user.username,
          url: `/${user.username}/`,
          image: shape.image_medium_url,
          is_admin: Boolean(user.is_admin),
          image_preview_pins: [],
        });
      }
      if (!items.length) {
        items.push({
          display_query: null,
          vertical: 'pins',
          link: `/search/pins/?q=${encodeURIComponent(term)}&rs=rs`,
          vase_event_type: null,
          vase_image_signature: null,
          vase_timestamp: null,
          tag: 'recent_queries',
          identifier_icon_name: null,
          vase_pin_id: null,
          query: term,
          id: `rs_${b64(term).replace(/[^a-z0-9]/gi, '').slice(0, 8)}`,
          type: 'recent_query',
          label: term,
          url: `/search/pins/?q=${encodeURIComponent(term)}&rs=rs`,
          image: '',
          image_preview_pins: [],
        });
      }
      return {
        data: { items },
        endpoint_name: 'v3_autocomplete_handler',
      };
    },
  },

  ConversationsResource: {
    get() {
      return { data: [], endpoint_name: 'v3_conversations' };
    },
  },

  NewsHubBadgeResource: {
    get() {
      return {
        data: STATIC_SEED.news_hub ||
          { conversations_unseen_count: 0, news_hub_count: 0 },
        simple: true,
      };
    },
  },

  UserExperiencePlatformResource: {
    get({ options }) {
      const data = options.multiExperiencePlatform
        ? (STATIC_SEED.experiences_multi || {})
        : (STATIC_SEED.experiences || {});
      return { data, endpoint_name: 'v3_get_experiences_by_platform' };
    },
  },

  UserExperienceResource: {
    get() {
      return { data: {}, endpoint_name: 'v3_get_experiences' };
    },
  },

  ActivateExperimentResource: {
    create({ options }) {
      const experiments = options.experiments || [];
      return {
        data: experiments.map((experiment) => ({
          group: experiment.experiment_group ?? experiment.group,
        })),
        endpoint_name: 'v3_activate_experiments',
      };
    },
  },

  UserRegisterTrackActionResource: {
    update() {
      return { data: null, endpoint_name: 'v3_user_register_track_action' };
    },
  },

  AdminResource: {
    get({ options = {} }, ctx) {
      const guard = adminGuard(ctx);
      if (guard) return { data: null, ...guard, endpoint_name: 'v3_admin' };
      const section = String(options.section || 'overview');

      if (section === 'users') {
        const query = String(options.query || '').trim().toLowerCase();
        const like = `%${query}%`;
        const rows = db.prepare(`
          SELECT u.*,
            (SELECT COUNT(*) FROM warnings w
               WHERE w.user_id = u.id AND w.acknowledged_at IS NULL)
              AS warning_count,
            (SELECT COUNT(*) FROM pins p WHERE p.pinner_id = u.id)
              AS live_pin_count
          FROM users u
          WHERE (? = '' OR lower(u.username) LIKE ? OR lower(u.full_name) LIKE ?)
          ORDER BY u.is_admin DESC, u.is_banned DESC, u.is_restricted DESC,
                   lower(u.username)
          LIMIT 500`).all(query, like, like);
        return {
          data: rows.map((row) => ({
            id: String(row.id),
            username: row.username,
            full_name: row.full_name || row.username,
            image_medium_url: userShape(row).image_medium_url,
            is_admin: Boolean(row.is_admin),
            is_banned: Boolean(row.is_banned),
            ban_reason: row.ban_reason || '',
            banned_at: row.banned_at || null,
            is_restricted: Boolean(row.is_restricted),
            restrict_reason: row.restrict_reason || '',
            restricted_at: row.restricted_at || null,
            is_demo: !row.password_hash,
            pin_count: Number(row.live_pin_count) || 0,
            warning_count: Number(row.warning_count) || 0,
          })),
          endpoint_name: 'v3_admin_users',
        };
      }

      if (section === 'pins') {
        const query = String(options.query || '').trim().toLowerCase();
        const like = `%${query}%`;
        const rows = db.prepare(`
          SELECT p.*, b.name AS board_name,
                 u.username AS pinner_username, u.full_name AS pinner_name
          FROM pins p
          LEFT JOIN boards b ON b.id = p.board_id
          LEFT JOIN users u ON u.id = p.pinner_id
          WHERE (? = '' OR lower(p.title) LIKE ? OR lower(p.description) LIKE ?
                 OR lower(coalesce(u.username, '')) LIKE ?)
          ORDER BY p.feed_rank IS NULL, p.feed_rank, p.created_at DESC
          LIMIT 500`).all(query, like, like, like);
        return {
          data: rows.map((row) => {
            const images = pinImages(row);
            const img = images['236x'] || images['474x'] || images.orig || {};
            return {
              id: String(row.id),
              title: row.title || '',
              description: row.description || '',
              image_url: img.url || row.img_url || null,
              board_name: row.board_name || '',
              pinner_username: row.pinner_username || '',
              pinner_name: row.pinner_name || row.pinner_username || '',
              created_at: row.created_at || null,
              source: row.source || 'har',
              is_created: row.source === 'created',
            };
          }),
          endpoint_name: 'v3_admin_pins',
        };
      }

      if (section === 'log') {
        return { data: moderationLog(200), endpoint_name: 'v3_admin_log' };
      }

      const counts = {
        accounts: db.prepare(
          'SELECT COUNT(*) n FROM users WHERE password_hash IS NOT NULL').get().n,
        demo_accounts: db.prepare(
          'SELECT COUNT(*) n FROM users WHERE password_hash IS NULL').get().n,
        admins: db.prepare(
          'SELECT COUNT(*) n FROM users WHERE is_admin = 1').get().n,
        banned: db.prepare(
          'SELECT COUNT(*) n FROM users WHERE is_banned = 1').get().n,
        restricted: db.prepare(
          'SELECT COUNT(*) n FROM users WHERE is_restricted = 1').get().n,
        warnings: db.prepare(
          'SELECT COUNT(*) n FROM warnings WHERE acknowledged_at IS NULL').get().n,
        pins: db.prepare('SELECT COUNT(*) n FROM pins').get().n,
        created_pins: db.prepare(
          "SELECT COUNT(*) n FROM pins WHERE source = 'created'").get().n,
        actions: db.prepare(
          'SELECT COUNT(*) n FROM moderation_log').get().n,
      };
      return {
        data: { counts, recent: moderationLog(6) },
        endpoint_name: 'v3_admin_overview',
      };
    },

    create({ options = {} }, ctx) {
      const guard = adminGuard(ctx);
      if (guard) return { data: null, ...guard, endpoint_name: 'v3_admin' };
      const me = meOf(ctx);
      const action = String(options.action || '');

      try {
        if (['ban', 'unban', 'restrict', 'unrestrict', 'warn'].includes(action)) {
          const target = getUser.get(
            String(options.user_id || options.target_user_id || ''));
          if (!target) throw new ModerationError('Account not found.', 404);
          assertModeratable(me, target);
          const reason = String(options.reason || '').trim().slice(0, 500);
          const now = new Date().toISOString();

          if (action === 'ban') {
            db.prepare(`UPDATE users SET is_banned = 1, ban_reason = ?,
                        banned_at = ? WHERE id = ?`)
              .run(reason || null, now, target.id);
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
            logModeration(me, 'ban', { targetUser: target, detail: reason });
          } else if (action === 'unban') {
            db.prepare(`UPDATE users SET is_banned = 0, ban_reason = NULL,
                        banned_at = NULL WHERE id = ?`).run(target.id);
            logModeration(me, 'unban', { targetUser: target });
          } else if (action === 'restrict') {
            db.prepare(`UPDATE users SET is_restricted = 1, restrict_reason = ?,
                        restricted_at = ? WHERE id = ?`)
              .run(reason || null, now, target.id);
            logModeration(me, 'restrict', { targetUser: target, detail: reason });
          } else if (action === 'unrestrict') {
            db.prepare(`UPDATE users SET is_restricted = 0,
                        restrict_reason = NULL, restricted_at = NULL
                        WHERE id = ?`).run(target.id);
            logModeration(me, 'unrestrict', { targetUser: target });
          } else {
            const message = String(options.message || reason)
              .trim().slice(0, 500);
            if (!message) throw new ModerationError('Write a warning message.');
            const id = `w_${Date.now()}_${crypto.randomInt(100, 1000)}`;
            db.prepare(`INSERT INTO warnings
                (id, user_id, message, created_by, created_at)
                VALUES (?, ?, ?, ?, ?)`)
              .run(id, target.id, message, me.id, now);
            logModeration(me, 'warn', { targetUser: target, detail: message });
            return {
              data: { ok: true, action, user_id: target.id, warning_id: id },
              endpoint_name: 'v3_admin_action',
            };
          }
          return {
            data: { ok: true, action, user_id: target.id },
            endpoint_name: 'v3_admin_action',
          };
        }

        if (action === 'make_admin' || action === 'remove_admin') {
          const target = getUser.get(
            String(options.user_id || options.target_user_id || ''));
          if (!target) throw new ModerationError('Account not found.', 404);

          if (action === 'make_admin') {
            if (target.is_admin) {
              throw new ModerationError('This account is already an admin.');
            }
            if (!target.password_hash) {
              throw new ModerationError('Demo accounts cannot be made admins.');
            }
            db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(target.id);
            logModeration(me, 'make_admin', { targetUser: target });
          } else {
            if (!target.is_admin) {
              throw new ModerationError('This account is not an admin.');
            }
            if (target.id === me.id) {
              throw new ModerationError(
                'You cannot remove your own admin access.');
            }
            db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(target.id);
            logModeration(me, 'remove_admin', { targetUser: target });
          }

          return {
            data: { ok: true, action, user_id: target.id },
            endpoint_name: 'v3_admin_action',
          };
        }

        if (action === 'delete_pin') {
          const pin = getPin.get(
            String(options.pin_id || options.target_pin_id || ''));
          if (!pin) throw new ModerationError('Pin not found.', 404);
          const detail = pin.title || pin.description || pin.id;
          removePin(pin);
          logModeration(me, 'delete_pin', { targetPin: pin, detail });
          return {
            data: { ok: true, action, pin_id: pin.id },
            endpoint_name: 'v3_admin_action',
          };
        }

        if (action === 'delete_user') {
          const target = getUser.get(
            String(options.user_id || options.target_user_id || ''));
          if (!target) throw new ModerationError('Account not found.', 404);
          assertModeratable(me, target);
          const detail = `@${target.username}`;
          removeAccount(target);
          logModeration(me, 'delete_user', { detail });
          return {
            data: { ok: true, action, user_id: target.id },
            endpoint_name: 'v3_admin_action',
          };
        }

        if (action === 'reset_password') {
          const target = getUser.get(
            String(options.user_id || options.target_user_id || ''));
          if (!target) throw new ModerationError('Account not found.', 404);
          assertModeratable(me, target);
          if (!target.password_hash) {
            throw new ModerationError(
              'Demo accounts have no password to reset.');
          }
          const password = randomPassword(10);
          db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            .run(hashPassword(password), target.id);
          // Sign the account out everywhere so the old password cannot be
          // used by a session that was already open.
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
          logModeration(me, 'reset_password', {
            targetUser: target, detail: `@${target.username}`,
          });
          return {
            data: {
              ok: true, action, user_id: target.id,
              username: target.username, password,
            },
            endpoint_name: 'v3_admin_action',
          };
        }

        if (action === 'edit_user') {
          const target = getUser.get(
            String(options.user_id || options.target_user_id || ''));
          if (!target) throw new ModerationError('Account not found.', 404);
          assertModeratable(me, target);
          const fullName = String(options.full_name || '').trim().slice(0, 200);
          const username = String(options.username || '').trim().slice(0, 30);
          const about = String(options.about || '').trim().slice(0, 1000);
          const now = new Date().toISOString();
          db.prepare(`UPDATE users SET full_name = ?, username = ?, about = ? WHERE id = ?`)
            .run(fullName || target.full_name, username || target.username, about || target.about, target.id);
          logModeration(me, 'edit_user', { targetUser: target, detail: 'Edited user profile' });
          return {
            data: { ok: true, action, user_id: target.id },
            endpoint_name: 'v3_admin_action',
          };
        }

        throw new ModerationError('Unknown moderation action.', 400);
      } catch (error) {
        if (error instanceof ModerationError) {
          return {
            data: null, error: error.message, httpStatus: error.status,
            endpoint_name: 'v3_admin_action',
          };
        }
        throw error;
      }
    },
  },

  UserSessionResource: {
    get(_body, ctx) {
      return {
        data: sessionPayload(meOf(ctx)),
        simple: true,
      };
    },

    create({ options = {} }, ctx) {
      if (options.mode === 'signup' || options.mode === 'login') {
        try {
          const user = options.mode === 'signup'
            ? createAccount({
              fullName: options.full_name,
              username: options.username,
              email: options.email,
              password: options.password,
            })
            : login({
              identifier: options.identifier || options.username || options.email,
              password: options.password,
            });
          createSession(user.id, ctx.res);
          return {
            data: sessionPayload(user),
            simple: true,
          };
        } catch (error) {
          if (error instanceof AuthError) {
            return {
              data: { authenticated: false, error: error.message },
              simple: true,
              httpStatus: error.status,
            };
          }
          throw error;
        }
      }

      // HAR compatibility: the captured login call carries no credentials and
      // only checks the response envelope, so keep its original shape.  This
      // path deliberately does not create a session.
      const profileId = STATIC_SEED.user_profile?.id || '8298501452116908277';
      return {
        data: {
          success: true,
          session_accounts: { [profileId]: { logged_in: true } },
        },
        simple: true,
      };
    },

    update({ options = {} }, ctx) {
      if (options.action === 'logout' || options.logout) {
        destroySession(ctx.req, ctx.res);
        return { data: { authenticated: false }, simple: true };
      }
      if (options.action === 'update_profile' || options.action === 'edit_profile') {
        const me = meOf(ctx);
        if (!me) {
          return {
            data: null, error: 'unauthorized', simple: true, httpStatus: 401,
          };
        }

        const fullName = String(
          options.full_name ?? me.full_name ?? '').trim().slice(0, 200);
        const username = String(options.username ?? me.username ?? '').trim();
        const about = String(
          options.about ?? me.about ?? '').trim().slice(0, 1000);

        if (!fullName) {
          return {
            data: null, error: 'Enter your name.', simple: true, httpStatus: 400,
          };
        }
        if (!/^[A-Za-z0-9_.]{3,30}$/.test(username)) {
          return {
            data: null,
            error: 'Username must be 3-30 characters using letters, numbers, dots, or underscores.',
            simple: true, httpStatus: 400,
          };
        }
        const taken = db.prepare(
          'SELECT id FROM users WHERE lower(username) = lower(?) AND id <> ?')
          .get(username, me.id);
        if (taken) {
          return {
            data: null, error: 'That username is already taken.',
            simple: true, httpStatus: 409,
          };
        }

        let avatarUrl = null;
        if (options.image) {
          const match = /^data:image\/([a-z]+);base64,([a-z0-9+/=\s]+)$/i
            .exec(String(options.image));
          const type = match && IMAGE_TYPES[match[1].toLowerCase()];
          if (!type) {
            return {
              data: null,
              error: 'Choose a PNG, JPG, WebP, or GIF image.',
              simple: true, httpStatus: 400,
            };
          }
          const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
          if (!buffer.length) {
            return {
              data: null, error: 'That image file is empty.',
              simple: true, httpStatus: 400,
            };
          }
          if (buffer.length > MAX_UPLOAD_BYTES) {
            return {
              data: null, error: 'Images must be 8 MB or smaller.',
              simple: true, httpStatus: 400,
            };
          }
          if (!type.test(buffer)) {
            return {
              data: null, error: 'That file does not look like a valid image.',
              simple: true, httpStatus: 400,
            };
          }
          fs.mkdirSync(UPLOAD_DIR, { recursive: true });
          const fileName = `avatar_${me.id}.${type.ext}`;
          fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
          avatarUrl = `/uploads/${fileName}`;
        }

        if (avatarUrl) {
          db.prepare(`UPDATE users SET full_name = ?, username = ?, about = ?,
                      image_medium = ?, image_small = ?, image_large = ?,
                      image_xlarge = ? WHERE id = ?`)
            .run(fullName, username, about, avatarUrl, avatarUrl, avatarUrl,
              avatarUrl, me.id);
        } else {
          db.prepare(
            'UPDATE users SET full_name = ?, username = ?, about = ? WHERE id = ?')
            .run(fullName, username, about, me.id);
        }

        const updated = getUser.get(me.id);
        return {
          data: { ok: true, authenticated: true, user: userShape(updated) },
          simple: true,
        };
      }

      if (options.action === 'ack_warning') {
        const me = meOf(ctx);
        if (!me) {
          return {
            data: null, error: 'unauthorized', simple: true, httpStatus: 401,
          };
        }
        const id = String(options.warning_id || '');
        const warning = db.prepare(
          'SELECT * FROM warnings WHERE id = ? AND user_id = ?').get(id, me.id);
        if (!warning) {
          return {
            data: null, error: 'Warning not found.', simple: true, httpStatus: 404,
          };
        }
        db.prepare('UPDATE warnings SET acknowledged_at = ? WHERE id = ?')
          .run(new Date().toISOString(), id);
        return {
          data: { acknowledged: true, warning_id: id }, simple: true,
        };
      }
      return { data: null, simple: true };
    },
  },

  // Stats/logging endpoints the client fires constantly - just ack.
  ApiSResource: { create() { return { data: null, simple: true }; } },
  ApiCResource: { create() { return { data: null, simple: true }; } },

  // Generic /v3 proxy. options.url selects the inner endpoint.
  ApiResource: {
    get({ options }, ctx) {
      const url = options.url || '';
      const data = options.data || {};

      if (url === '/v3/users/me/') {
        const me = meOf(ctx);
        return {
          data: me ? meFields(me) : null,
          endpoint_name: 'v3_get_user',
        };
      }
      const metadata = url.match(/^\/v3\/users\/([^/]+)\/metadata\/?$/);
      if (metadata) {
        return {
          data: STATIC_SEED.user_metadata || {
            board_pin_rep_view_type: 'grid',
            most_recent_board_sort_order: 'last_pinned_to',
            profile_board_rep_view_type: 'grid',
            profile_pin_rep_view_type: 'grid',
          },
          endpoint_name: 'v3_get_user_metadata',
        };
      }
      if (url === '/v3/users/me/recent/engaged/pin/stories/') {
        return {
          data: STATIC_SEED.recent_engaged_stories || [],
          endpoint_name: 'v3_recent_engaged_stories',
        };
      }
      if (url === '/v3/search/ghost_queries/') {
        return {
          data: STATIC_SEED.ghost_queries || [],
          endpoint_name: 'v3_search_ghost_queries',
        };
      }
      if (url === '/v3/users/settings/gen_ai/') {
        return {
          data: STATIC_SEED.gen_ai_interests || [],
          endpoint_name: 'v3_gen_ai_interests',
        };
      }
      if (url.startsWith('/v3/search/')) {
        const term = String(data.query || options.query || '').toLowerCase();
        const pins = searchPins.all(...Array(4).fill(`%${term}%`));
        return {
          data: pins.map((pin) => pinShape(pin, {
            db, userId: meOf(ctx)?.id,
          })),
          bookmark: makeBookmark(null),
          endpoint_name: 'v3_search',
        };
      }
      const userMatch = url.match(/^\/v3\/users\/([^/]+)\/?$/);
      if (userMatch) {
        const user = userMatch[1] === 'me'
          ? meOf(ctx)
          : (getUser.get(userMatch[1]) || getUserByName.get(userMatch[1]));
        return {
          data: user ? userShape(user) : null,
          endpoint_name: 'v3_get_user',
        };
      }
      const boardMatch = url.match(/^\/v3\/boards\/([^/]+)\/?$/);
      if (boardMatch) {
        const board = getBoard.get(boardMatch[1]);
        return {
          data: board ? boardShape(board, { db }) : null,
          endpoint_name: 'v3_get_board',
        };
      }
      return { data: null, endpoint_name: 'v3_unknown' };
    },

    create({ options }, ctx) {
      const url = options.url || '';
      const data = options.data || {};

      if (url === '/v3/batch/') {
        const out = {};
        let requests = [];
        try {
          requests = Array.isArray(data.requests)
            ? data.requests : JSON.parse(data.requests || '[]');
        } catch { /* ignore */ }
        for (const request of requests) {
          const uri = String(request.uri || '').replace(/^\/+/, '');
          const userMatch = uri.match(/^v3\/users\/([^/]+)\/?$/);
          if (request.method === 'GET' && userMatch) {
            const user = userMatch[1] === 'me'
              ? meOf(ctx)
              : (getUser.get(userMatch[1]) || getUserByName.get(userMatch[1]));
            out[`GET:${uri}`] = {
              status: 'success',
              code: 0,
              message: 'ok',
              endpoint_name: 'v3_get_user_handler',
              data: user ? {
                ...meFields(user),
                id: String(user.id),
                username: user.username,
                full_name: user.full_name,
                image_medium_url: userShape(user).image_medium_url,
                owners: [],
                businesses: [],
                partner: null,
                fast_advertiser_info_has_any_managed_advertisers: false,
              } : null,
            };
          }
        }
        return { data: out, endpoint_name: 'v3_batch' };
      }
      if (url === '/v3/spam/fingerprints/') {
        return { data: null, endpoint_name: 'v3_spam_fingerprints' };
      }
      const save = url.match(
        /^\/v3\/(?:board\/([^/]+)\/pin\/([^/]+)|pins\/([^/]+))\/save\/?$/);
      if (save) {
        const boardId = save[1] || data.board_id || data.boardId;
        const pinId = save[2] || save[3] || data.pin_id || data.pinId;
        return {
          data: savePin(boardId, pinId, meOf(ctx)),
          endpoint_name: 'v3_save_pin',
        };
      }
      const react = url.match(/^\/v3\/pins\/([^/]+)\/reaction\/?$/);
      if (react) {
        return {
          data: reactPin(react[1], data.reaction ?? 1, meOf(ctx)),
          endpoint_name: 'v3_react_pin',
        };
      }
      const follow = url.match(/^\/v3\/users\/([^/]+)\/follow\/?$/);
      if (follow) {
        return {
          data: setFollow(follow[1], meOf(ctx), true),
          endpoint_name: 'v3_follow_user',
        };
      }
      return { data: null, endpoint_name: 'v3_unknown' };
    },

    update({ options }, ctx) {
      const url = options.url || '';
      const data = options.data || {};
      if (url.startsWith('/v3/experiences/')) {
        return { data: null, endpoint_name: 'v3_trigger_experience' };
      }
      if (url === '/v3/sessions/verify/') {
        return { data: {}, endpoint_name: 'v3_verify_session' };
      }
      const react = url.match(/^\/v3\/pins\/([^/]+)\/reaction\/?$/);
      if (react) {
        return {
          data: reactPin(react[1], data.reaction ?? 1, meOf(ctx)),
          endpoint_name: 'v3_react_pin',
        };
      }
      const unreact = url.match(/^\/v3\/pins\/([^/]+)\/(?:reaction\/)?unreact\/?$/);
      if (unreact) {
        return {
          data: unreactPin(unreact[1], meOf(ctx)),
          endpoint_name: 'v3_unreact_pin',
        };
      }
      const save = url.match(/^\/v3\/board\/([^/]+)\/pin\/([^/]+)\/save\/?$/);
      if (save) {
        return {
          data: savePin(save[1], save[2], meOf(ctx)),
          endpoint_name: 'v3_save_pin',
        };
      }
      const unfollow = url.match(/^\/v3\/users\/([^/]+)\/unfollow\/?$/);
      if (unfollow) {
        return {
          data: setFollow(unfollow[1], meOf(ctx), false),
          endpoint_name: 'v3_unfollow_user',
        };
      }
      const follow = url.match(/^\/v3\/users\/([^/]+)\/follow\/?$/);
      if (follow) {
        return {
          data: setFollow(follow[1], meOf(ctx), data.follow !== false),
          endpoint_name: 'v3_follow_user',
        };
      }
      return { data: null, endpoint_name: 'v3_unknown' };
    },
  },
};

function meFields(me) {
  return {
    email: me.email || `${me.username}@example.local`,
    full_name: me.full_name,
    is_email_eligible_for_lead_form_autofill: false,
    is_name_eligible_for_lead_form_autofill: false,
    node_id: nodeId('User', me.id),
  };
}

function savePin(boardId, pinId, me) {
  if (!me) return { saved: false, error: 'unauthorized' };
  if (me.is_restricted) {
    return {
      saved: false,
      error: 'Your account is restricted from saving Pins.',
    };
  }
  const pin = pinId ? getPin.get(String(pinId)) : null;
  if (!pin) return { saved: false, error: 'pin_not_found' };

  let board = boardId ? getBoard.get(String(boardId)) : null;
  if (!board) board = boardsOf.get(me.id);
  if (!board) return { saved: false, error: 'board_not_found' };

  const existing = db.prepare(
    'SELECT board_id FROM saved WHERE pin_id = ? AND user_id = ?')
    .get(pin.id, me.id);

  if (existing) {
    if (existing.board_id !== board.id) {
      db.prepare('UPDATE saved SET board_id = ? WHERE pin_id = ? AND user_id = ?')
        .run(board.id, pin.id, me.id);
      recountBoard(existing.board_id);
    }
  } else {
    db.prepare(`INSERT INTO saved (pin_id, user_id, board_id, created_at)
                VALUES (?, ?, ?, datetime('now'))`)
      .run(pin.id, me.id, board.id);
  }
  recountBoard(board.id);
  return { saved: true, board_id: board.id, pin_id: pin.id };
}

function setFollow(targetRef, me, shouldFollow) {
  if (!me) return { following: false, error: 'unauthorized' };
  const target = getUser.get(String(targetRef)) ||
    getUserByName.get(String(targetRef));
  if (!target) return { following: false, error: 'user_not_found' };
  if (target.id === me.id) {
    return { following: false, error: 'You cannot follow yourself.' };
  }

  const existing = db.prepare(
    'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?')
    .get(me.id, target.id);

  if (shouldFollow && !existing) {
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO follows (follower_id, following_id, created_at)
                  VALUES (?, ?, ?)`)
        .run(me.id, target.id, new Date().toISOString());
      db.prepare(`UPDATE users
                  SET follower_count = COALESCE(follower_count, 0) + 1
                  WHERE id = ?`).run(target.id);
      db.prepare(`UPDATE users
                  SET following_count = COALESCE(following_count, 0) + 1
                  WHERE id = ?`).run(me.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else if (!shouldFollow && existing) {
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM follows
                  WHERE follower_id = ? AND following_id = ?`)
        .run(me.id, target.id);
      db.prepare(`UPDATE users
                  SET follower_count = MAX(COALESCE(follower_count, 0) - 1, 0)
                  WHERE id = ?`).run(target.id);
      db.prepare(`UPDATE users
                  SET following_count = MAX(COALESCE(following_count, 0) - 1, 0)
                  WHERE id = ?`).run(me.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const freshTarget = getUser.get(target.id);
  const freshMe = getUser.get(me.id);
  const following = Boolean(db.prepare(
    'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?')
    .get(me.id, target.id));
  return {
    following,
    user_id: String(target.id),
    follower_count: freshTarget.follower_count ?? 0,
    following_count: freshMe.following_count ?? 0,
  };
}

function recountBoard(boardId) {
  if (!boardId) return;
  db.prepare(`UPDATE boards SET pin_count = (
      SELECT COUNT(*) FROM (
        SELECT id FROM pins WHERE pins.board_id = boards.id
        UNION
        SELECT pin_id FROM saved WHERE saved.board_id = boards.id
      )
    ) WHERE id = ?`).run(boardId);
}

class PinError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PinError';
    this.status = status;
  }
}

const IMAGE_TYPES = {
  png: { ext: 'png', test: (b) => b.subarray(0, 4).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  jpeg: { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpg: { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { ext: 'gif', test: (b) => b.subarray(0, 4).toString() === 'GIF8' },
  webp: {
    ext: 'webp',
    test: (b) => b.subarray(0, 4).toString() === 'RIFF' &&
      b.subarray(8, 12).toString() === 'WEBP',
  },
};

function nextPinId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = String(Date.now()) + String(crypto.randomInt(100, 1000));
    if (!getPin.get(id)) return id;
  }
  throw new PinError('Could not allocate a pin id.', 500);
}

function createPin(options, me) {
  const title = String(options.title || '').trim();
  const description = String(options.description || '').trim();
  if (title.length > 100) {
    throw new PinError('Titles must be 100 characters or fewer.');
  }
  if (description.length > 800) {
    throw new PinError('Descriptions must be 800 characters or fewer.');
  }

  const dataUrl = String(options.image || '');
  const match = /^data:image\/([a-z]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) {
    throw new PinError('Choose a PNG, JPG, WebP, or GIF image.');
  }
  const type = IMAGE_TYPES[match[1].toLowerCase()];
  if (!type) {
    throw new PinError('Choose a PNG, JPG, WebP, or GIF image.');
  }
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new PinError('That image file is empty.');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new PinError('Images must be 8 MB or smaller.');
  }
  if (!type.test(buffer)) {
    throw new PinError('That file does not look like a valid image.');
  }

  let board = options.board_id ? getBoard.get(String(options.board_id)) : null;
  if (board && String(board.user_id) !== String(me.id)) {
    throw new PinError('You can only publish to your own boards.', 403);
  }
  if (!board) board = boardsOf.get(me.id);
  if (!board) throw new PinError('Create a board before publishing a Pin.');

  const width = Math.max(1, Math.min(10000, Number(options.width) || 1000));
  const height = Math.max(1, Math.min(10000, Number(options.height) || 1000));
  const pinId = nextPinId();
  const url = `/uploads/${pinId}.${type.ext}`;
  const filePath = path.join(UPLOAD_DIR, `${pinId}.${type.ext}`);
  const images = Object.fromEntries(
    ['orig', '736x', '564x', '474x', '236x'].map(
      (key) => [key, { url, width, height }]));

  const minRank = db.prepare(
    'SELECT COALESCE(MIN(feed_rank), 0) AS n FROM pins WHERE feed_rank IS NOT NULL')
    .get().n;
  const feedRank = Number(minRank) - 1;

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(filePath, buffer);

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO pins (id, title, description, dominant_color, created_at,
        is_video, link, domain, image_sig, img_url, img_width, img_height,
        images_json, repin_count, comment_count, board_id, pinner_id, creator_id,
        feed_rank, reaction_counts_json, source)
      VALUES (?,?,?,?,?,0,NULL,NULL,NULL,?,?,?,?,0,0,?,?,?,?,?,'created')`)
      .run(
        pinId, title, description, '#efefef', new Date().toUTCString(),
        url, width, height, JSON.stringify(images), board.id, me.id, me.id,
        feedRank, JSON.stringify({}),
      );
    db.prepare(`INSERT INTO saved (pin_id, user_id, board_id, created_at)
                VALUES (?, ?, ?, ?)`)
      .run(pinId, me.id, board.id, new Date().toISOString());
    db.prepare('UPDATE users SET pin_count = COALESCE(pin_count, 0) + 1 WHERE id = ?')
      .run(me.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
    throw error;
  }

  recountBoard(board.id);
  return getPin.get(pinId);
}

function reactPin(pinId, reaction, me) {
  if (!me) return { reacted: false, error: 'unauthorized' };
  if (me.is_restricted) {
    return {
      reacted: false,
      error: 'Your account is restricted from reacting to Pins.',
    };
  }
  const pin = getPin.get(String(pinId));
  if (!pin) return { reacted: false, error: 'pin_not_found' };
  db.prepare(`INSERT INTO reactions (pin_id, user_id, type) VALUES (?, ?, ?)
              ON CONFLICT(pin_id, user_id) DO UPDATE SET type = excluded.type`)
    .run(pin.id, me.id, Number(reaction) || 1);
  return { reacted: true, pin_id: pin.id, reaction: Number(reaction) || 1 };
}

function unreactPin(pinId, me) {
  if (!me) return { reacted: false, error: 'unauthorized' };
  db.prepare('DELETE FROM reactions WHERE pin_id = ? AND user_id = ?')
    .run(String(pinId), me.id);
  return { reacted: false, pin_id: String(pinId) };
}

export { envelope, parseData, handlers };
