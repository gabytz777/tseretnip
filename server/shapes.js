// Builders for the Pinterest resource-response contract observed in the HAR:
// every /resource/... call answers
//   { resource_response: { data, bookmark? }, client_context, resource, request_identifier }
// and embedded entities use base64 "node_id"s like "Pin:<id>", "User:<id>", "Board:<id>".
//
// Seed rows carry a sanitized copy of the original HAR node in `raw_json`.
// The builders start from that node (so field names match the capture) and then
// overlay live SQLite state such as saved/reacted flags and reaction counts.

export const b64 = (value) => Buffer.from(value).toString('base64');
export const nodeId = (kind, id) => b64(`${kind}:${id}`);

// Cursor: our own opaque bookmark - base64 JSON {"o": offset}.
export const makeBookmark = (offset) =>
  offset == null ? '-end-' : b64(JSON.stringify({ o: offset }));

export const parseBookmark = (bookmark) => {
  if (!bookmark || bookmark === '-end-') return null;
  try {
    const parsed = JSON.parse(Buffer.from(bookmark, 'base64').toString('utf8'));
    return Number.isInteger(parsed.o) ? parsed.o : null;
  } catch {
    return null;
  }
};

export const CREATED_AT = 'Fri, 16 May 2025 08:14:52 +0000';

// Gray placeholder avatar (data URI) for users whose avatar isn't captured.
const AVATAR_PLACEHOLDER =
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 75 75">' +
    '<rect width="75" height="75" fill="#d8d8d8"/>' +
    '<circle cx="37.5" cy="28" r="14" fill="#a5a5a5"/>' +
    '<ellipse cx="37.5" cy="66" rx="26" ry="22" fill="#a5a5a5"/></svg>');

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Up to 4 pride-flag ids displayed next to a user's name.
function parseFlags(value) {
  let flags = [];
  try {
    flags = JSON.parse(value || '[]');
  } catch {
    flags = [];
  }
  if (!Array.isArray(flags)) return [];
  return flags
    .filter((flag) => typeof flag === 'string' && /^[a-z0-9_]{1,24}$/.test(flag))
    .slice(0, 4);
}

function localImage(url) {
  if (typeof url !== 'string') return null;
  return url.startsWith('/img/') || url.startsWith('/uploads/') ? url : null;
}

function avatar(url) {
  return localImage(url) || AVATAR_PLACEHOLDER;
}

export function userShape(user, { followedByMe = false } = {}) {
  if (!user) return undefined;
  const raw = parseJson(user.raw_json, {}) || {};
  const medium = avatar(user.image_medium || raw.image_medium_url);
  const large = localImage(user.image_large || raw.image_large_url) || medium;
  const xlarge = localImage(user.image_xlarge || raw.image_xlarge_url) || large;
  return {
    is_verified_merchant: false,
    verified_identity: {},
    is_primary_website_verified: false,
    is_ads_only_profile: false,
    ...raw,
    node_id: nodeId('User', user.id),
    username: user.username || raw.username,
    explicitly_followed_by_me: followedByMe,
    type: 'user',
    full_name: user.full_name || raw.full_name || user.username || '',
    about: user.about || raw.about || '',
    follower_count: user.follower_count ?? raw.follower_count ?? 0,
    following_count: user.following_count ?? raw.following_count ?? 0,
    image_medium_url: medium,
    image_small_url: avatar(user.image_small || raw.image_small_url),
    image_large_url: large,
    image_xlarge_url: xlarge,
    id: String(user.id),
    is_admin: Boolean(user.is_admin),
    is_banned: Boolean(user.is_banned),
    is_restricted: Boolean(user.is_restricted),
    flags: parseFlags(user.flags),
  };
}

export function boardShape(board, { db, pinCount, owner } = {}) {
  if (!board) return undefined;
  const raw = parseJson(board.raw_json, {}) || {};
  const coverImages = parseJson(board.cover_images_json, raw.cover_images || null);
  let ownerRow = owner;
  if (!ownerRow && board.user_id && db) {
    ownerRow = db.prepare('SELECT * FROM users WHERE id = ?').get(board.user_id);
  }
  const ownerShape = ownerRow ? userShape(ownerRow) : raw.owner;

  return {
    ...raw,
    node_id: nodeId('Board', board.id),
    section_count: raw.section_count ?? 0,
    image_cover_url: board.image_cover_url || raw.image_cover_url || null,
    followed_by_me: false,
    name: board.name || raw.name,
    id: String(board.id),
    owner: ownerShape,
    collaborating_users: raw.collaborating_users || [],
    image_cover_hd_url: board.cover_url || raw.image_cover_hd_url || null,
    image_thumbnail_url: board.image_thumbnail_url || raw.image_thumbnail_url || null,
    board_order_modified_at: board.board_order_modified_at ||
      raw.board_order_modified_at || null,
    collaborator_count: board.collaborator_count ?? raw.collaborator_count ?? 0,
    cover_images: coverImages || undefined,
    type: 'board',
    is_collaborative: Boolean(board.is_collaborative ?? raw.is_collaborative),
    collaborated_by_me: false,
    url: board.url || raw.url || `/${board.name}/`,
    pin_count: pinCount ?? board.pin_count ?? raw.pin_count ?? 0,
    access: raw.access || [],
  };
}

export function pinImages(pin) {
  const images = parseJson(pin.images_json, null);
  if (images && Object.keys(images).length) return images;
  const raw = parseJson(pin.raw_json, {}) || {};
  return raw.images || {
    orig: { width: pin.img_width || 0, height: pin.img_height || 0, url: pin.img_url },
  };
}

export function pinShape(pin, { db, fieldSet = 'hf_grid', userId = null } = {}) {
  if (!pin) return undefined;
  const raw = parseJson(pin.raw_json, {}) || {};
  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const getBoard = db.prepare('SELECT * FROM boards WHERE id = ?');
  const getReactions = db.prepare(
    'SELECT COALESCE(SUM(type), 0) AS n FROM reactions WHERE pin_id = ?');
  const getSaved = db.prepare(
    'SELECT board_id FROM saved WHERE pin_id = ? AND user_id = ?');
  const getReacted = db.prepare(
    'SELECT type FROM reactions WHERE pin_id = ? AND user_id = ?');
  const getFollow = db.prepare(
    'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?');
  const getLiveComments = db.prepare(
    'SELECT COUNT(*) AS n FROM comments WHERE pin_id = ?');
  const followedByMe = (id) => Boolean(
    userId && id && getFollow.get(String(userId), String(id)));

  const board = getBoard.get(pin.board_id);
  const pinner = getUser.get(pin.pinner_id || pin.creator_id);
  const creator = getUser.get(pin.creator_id) || pinner;
  const saved = userId ? getSaved.get(pin.id, String(userId)) : null;
  const reacted = userId ? getReacted.get(pin.id, String(userId)) : null;

  const baseCounts = parseJson(pin.reaction_counts_json, {}) || {};
  const reactionCounts = { ...baseCounts };
  const liveReactions = getReactions.get(pin.id).n || 0;
  if (liveReactions) {
    reactionCounts['1'] = (Number(reactionCounts['1']) || 0) + liveReactions;
  }

  const node = {
    should_open_in_stream: false,
    is_eligible_for_related_products: false,
    is_premiere: false,
    is_eligible_for_pre_loved_goods_label: false,
    is_stale_product: false,
    type: 'pin',
    is_prefetch_enabled: false,
    is_oos_product: false,
    is_go_linkless: false,
    access: [],
    is_eligible_for_web_closeup: true,
    is_downstream_promotion: false,
    shopping_flags: [],
    link_utm_applicable_and_replaced: 0,
    promoted_is_lead_ad: false,
    ...raw,
    node_id: nodeId('Pin', pin.id),
    dominant_color: pin.dominant_color || raw.dominant_color || '#c6c6c6',
    image_signature: pin.image_sig || raw.image_signature || '',
    id: String(pin.id),
    root_pin_id: String(pin.id),
    reaction_counts: reactionCounts,
    images: pinImages(pin),
    title: pin.title || raw.title || '',
    is_video: Boolean(pin.is_video),
    pinner: pinner ? userShape(pinner, {
      followedByMe: followedByMe(pinner.id),
    }) : raw.pinner,
    native_creator: creator ? userShape(creator, {
      followedByMe: followedByMe(creator.id),
    }) : raw.native_creator,
    closeup_unified_attribution: creator
      ? userShape(creator, { followedByMe: followedByMe(creator.id) })
      : raw.closeup_unified_attribution,
    domain: pin.domain || raw.domain || 'Uploaded by user',
    grid_title: pin.title || raw.grid_title || '',
    created_at: pin.created_at || raw.created_at || CREATED_AT,
    description: pin.description || raw.description || '',
    link: pin.link || raw.link || null,
    link_domain: parseJson(pin.link_domain_json, raw.link_domain || undefined),
    image_crop: parseJson(pin.image_crop_json, raw.image_crop || undefined),
    recommendation_reason: parseJson(
      pin.recommendation_reason_json, raw.recommendation_reason || undefined),
    repin_count: pin.repin_count ?? raw.repin_count ?? 0,
    // Seeded pins carry the captured count; live comments are added on top so
    // the number always matches the comment list.
    comment_count: (pin.comment_count ?? raw.comment_count ?? 0) +
      getLiveComments.get(pin.id).n,
    board: board ? boardShape(board, { db }) : raw.board,
    saved_info: {
      saved: Boolean(saved),
      board_id: saved?.board_id || null,
      reacted: Boolean(reacted),
    },
  };

  if (fieldSet === 'hf_grid') {
    node.see_more_user_feedback = raw.see_more_user_feedback ||
      '{"2": {"5": ["RECOMMENDED_TOPICS"]}}';
    node.ad_match_reason = raw.ad_match_reason ?? 0;
    node.promoted_is_removable = raw.promoted_is_removable ?? false;
    node.is_eligible_for_pdp = raw.is_eligible_for_pdp ?? false;
  }

  if (fieldSet === 'closeup') {
    node.closeup_attribution = node.native_creator;
    node.closeup_unified_title = node.title;
    node.closeup_unified_description = {
      title: node.title || '',
      description: node.description || '',
    };
    node.is_eligible_for_web_closeup = true;
    node.origin_pin_ids = [String(pin.id)];
  }

  return node;
}

// A compact pin node for typeahead previews (the HAR uses a different, flatter
// shape there than in the feed).
export function previewPinShape(pin) {
  if (!pin) return undefined;
  const raw = parseJson(pin.raw_json, {}) || {};
  const images = pinImages(pin);
  const medium = images['236x'] || images['170x'] || images.orig || {};
  const large = images['736x'] || images['564x'] || images['474x'] || medium;
  return {
    node_id: nodeId('Pin', pin.id),
    description: pin.description || raw.description || ' ',
    price_value: raw.price_value ?? 0,
    tracked_link: raw.tracked_link || pin.link || null,
    link: pin.link || raw.link || null,
    image_medium_url: medium.url || null,
    attribution: raw.attribution ?? null,
    is_downstream_promotion: false,
    image_large_url: large.url || null,
    promoter: null,
    image_square_url: medium.url || null,
    domain: pin.domain || raw.domain || null,
    is_repin: raw.is_repin ?? true,
    image_square_size_points: { width: 75, height: 75 },
    is_playable: false,
    image_medium_size_pixels: {
      width: medium.width || 236, height: medium.height || 236,
    },
    is_video: Boolean(pin.is_video),
    id: String(pin.id),
    price_currency: raw.price_currency || 'USD',
    comment_count: pin.comment_count || 0,
    title: pin.title || raw.title || '',
    is_uploaded: raw.is_uploaded ?? true,
    cacheable_id: String(pin.id),
    image_large_size_points: {
      width: large.width || 736, height: large.height || 736,
    },
    image_square_size_pixels: { width: 75, height: 75 },
    image_medium_size_points: {
      width: medium.width || 236, height: medium.height || 236,
    },
    created_at: pin.created_at || raw.created_at || CREATED_AT,
    repin_count: pin.repin_count || 0,
    image_large_size_pixels: {
      width: large.width || 736, height: large.height || 736,
    },
    type: 'pin',
  };
}
