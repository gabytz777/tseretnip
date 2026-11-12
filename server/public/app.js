// Frontend for Tseretnip. Talks to the /resource/... API using the
// exact envelope captured in the HAR (data param + resource_response).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PLACEHOLDER_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 75 75">' +
  '<rect width="75" height="75" fill="#d8d8d8"/>' +
  '<circle cx="37.5" cy="28" r="14" fill="#a5a5a5"/>' +
  '<ellipse cx="37.5" cy="66" rx="26" ry="22" fill="#a5a5a5"/></svg>');

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
};

function icon(name, cls = '') {
  return `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// Blue check shown next to the name of an instance admin.
function adminTick(isAdmin) {
  if (!isAdmin) return '';
  return '<svg class="verified-badge" viewBox="0 0 24 24" role="img" aria-label="Admin"><title>Admin</title><circle cx="12" cy="12" r="10"/><path d="m7.5 12.5 3 3 6-6"/></svg>';
}

// Pride flags users can pin next to their name (up to 4).  Ids must satisfy
// the server-side /^[a-z0-9_]{1,24}$/ validation; unknown ids are ignored.
const FLAGS = {
  rainbow: { label: 'Pride', colors: ['#e40303', '#ff8c00', '#ffed00', '#008026', '#004dff', '#750787'] },
  gay: { label: 'Gay men', colors: ['#078d70', '#26ceaa', '#98e98c', '#3b1f77', '#5088c5'] },
  lesbian: { label: 'Lesbian', colors: ['#d62900', '#ff9b55', '#ffffff', '#d461a6', '#a50062'] },
  bi: { label: 'Bisexual', colors: ['#d60270', '#9b4f96', '#0038a8'] },
  pan: { label: 'Pansexual', colors: ['#ff1b6d', '#ffda34', '#1bb3ff'] },
  trans: { label: 'Transgender', colors: ['#5bcefa', '#f5a9b8', '#ffffff', '#f5a9b8', '#5bcefa'] },
  nonbinary: { label: 'Non-binary', colors: ['#fcf434', '#ffffff', '#9d59d2', '#2c2c2c'] },
  genderqueer: { label: 'Genderqueer', colors: ['#b57edc', '#ffffff', '#4a8123'] },
  genderfluid: { label: 'Genderfluid', colors: ['#ff75a2', '#c184d9', '#ffeb33', '#333333', '#333eb2'] },
  agender: { label: 'Agender', colors: ['#000000', '#bcc4cf', '#ffffff', '#b8f483', '#ffffff', '#bcc4cf', '#000000'] },
  aro: { label: 'Aromantic', colors: ['#3da542', '#a8d47f', '#ffffff', '#a9a9a9', '#000000'] },
  ace: { label: 'Asexual', colors: ['#000000', '#a3a3a3', '#ffffff', '#810081'] },
  intersex: { label: 'Intersex' },
};

function flagGradient(id) {
  const flag = FLAGS[id];
  if (!flag) return '';
  if (id === 'intersex') {
    return 'background:radial-gradient(circle at 50% 50%, #610097 0 32%, transparent 32%), #fffd00';
  }
  const stops = flag.colors
    .map((color, i) => `${color} ${(i / flag.colors.length * 100).toFixed(1)}% ${((i + 1) / flag.colors.length * 100).toFixed(1)}%`)
    .join(', ');
  return `background:linear-gradient(180deg, ${stops})`;
}

function flagHtml(flags) {
  const list = (Array.isArray(flags) ? flags : []).filter((id) => FLAGS[id]).slice(0, 4);
  if (!list.length) return '';
  return `<span class="flag-row">${list.map((id) =>
    `<span class="flag" title="${esc(FLAGS[id].label)}" style="${flagGradient(id)}"></span>`
  ).join('')}</span>`;
}

const EXPLORE_CHIPS = [
  'All', 'Home decor', 'Food', 'Travel', 'Art', 'Fashion', 'Beauty', 'DIY',
];
const SEARCH_CHIPS = ['All Pins', 'Boards', 'Profiles'];

// Each admin section is its own page under /admin.  URLs use the public
// names (accounts/posts); the resource sections are users/pins.
const ADMIN_PATHS = {
  overview: '/admin',
  users: '/admin/accounts',
  pins: '/admin/pins',
  log: '/admin/log',
};
const ADMIN_ROUTE_TABS = {
  '/admin': 'overview',
  '/admin/accounts': 'users',
  '/admin/pins': 'pins',
  '/admin/posts': 'pins',
  '/admin/log': 'log',
};
const ADMIN_TITLES = {
  overview: 'Admin',
  users: 'Admin · Accounts',
  pins: 'Admin · Pins',
  log: 'Admin · Log',
};

const state = {
  view: 'home',          // home | explore | search | board | profile
  searchTerm: '',
  board: null,
  bookmark: null,
  loading: false,
  loadToken: 0,
  pins: [],
  pinById: new Map(),
  cardEls: new Map(),
  columns: [],
  colCount: 0,
  me: null,
  warnings: [],
  restriction: null,
  adminTab: 'overview',
  adminPending: null,
  adminFlags: new Set(),
  adminUsers: [],
  adminPins: [],
  boards: null,
  boardCovers: null,
  currentPin: null,
  comments: new Map(),
  profileUsername: null,
  flagSelection: new Set(),
  networkUser: null,
  taItems: [],
  taIndex: -1,
};

let taTimer = null;
let toastTimer = null;
let resizeTimer = null;
let scrollTick = false;
let createImage = null;
let profileEditImage = null;
let pinRequest = 0;
let profileToken = 0;

// ---------------------------------------------------------------- API helpers
async function resourceGet(name, options) {
  const data = encodeURIComponent(JSON.stringify({ options, context: {} }));
  const r = await fetch(`/resource/${name}/get/?source_url=%2F&data=${data}`);
  const j = await r.json();
  return j.resource_response;
}

async function resourceSend(name, verb, options) {
  const r = await fetch(`/resource/${name}/${verb}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `source_url=%2F&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`,
  });
  const j = await r.json();
  return j.resource_response;
}

// --------------------------------------------------------------- masonry grid
function columnCount() {
  return Math.max(2, Math.min(7, Math.floor((window.innerWidth + 16) / 252)));
}

function createColumns(n) {
  const feed = $('#feed');
  feed.innerHTML = '';
  state.columns = [];
  for (let i = 0; i < n; i += 1) {
    const col = document.createElement('div');
    col.className = 'masonry-col';
    feed.appendChild(col);
    state.columns.push(col);
  }
  state.colCount = n;
}

function shortestColumn() {
  return state.columns.reduce(
    (best, col) => (col.offsetHeight < best.offsetHeight ? col : best),
    state.columns[0],
  );
}

function placeCard(card) {
  const col = shortestColumn();
  if (col) col.appendChild(card);
}

function relayout() {
  const n = columnCount();
  if (n === state.colCount && state.columns.length === n) return;
  const cards = state.pins
    .map((pin) => state.cardEls.get(pin.id))
    .filter(Boolean);
  createColumns(n);
  for (const card of cards) placeCard(card);
}

function resetFeed() {
  state.loadToken += 1;
  state.loading = false;
  state.bookmark = null;
  state.pins = [];
  state.pinById.clear();
  state.cardEls.clear();
  $('#empty').classList.add('hidden');
  createColumns(columnCount());
}

// --------------------------------------------------------------------- pins
function createPinCard(pin) {
  const images = pin.images || {};
  const img = images['236x'] || images['474x'] || images['564x'] || images.orig;
  if (!img || !img.url) return null;

  const width = Number(img.width) || 236;
  const height = Number(img.height) || 236;
  const shownHeight = Math.min(height, Math.round(width * 1.9));
  const cropped = shownHeight !== height;

  const saved = Boolean(pin.saved_info?.saved);
  const title = (pin.title || pin.description || '').trim();
  const creator = pin.native_creator || pin.pinner || {};
  const creatorName = creator.full_name || creator.username || '';
  const domain = pin.domain && pin.domain !== 'Uploaded by user' ? pin.domain : '';

  const card = document.createElement('article');
  card.className = 'pin-card';
  card.dataset.id = pin.id;
  card.tabIndex = 0;
  card.innerHTML = `
    <div class="pin-image-wrap"
         style="aspect-ratio:${width}/${shownHeight};background:${escAttr(pin.dominant_color || '#efefef')}">
      <img ${cropped ? 'class="cropped"' : ''} loading="lazy" decoding="async"
           src="${escAttr(img.url)}" alt="${escAttr(title)}">
      <div class="pin-overlay">
        <button class="save-pill ${saved ? 'saved' : ''}" type="button"
                aria-label="${saved ? 'Saved' : 'Save'} pin">${saved ? 'Saved' : 'Save'}</button>
        <div class="pin-overlay-bottom">
          <span class="pin-domain">${esc(domain)}</span>
          <div class="pin-actions">
            <button class="overlay-icon" type="button" data-action="share" aria-label="Share">
              ${icon('share')}
            </button>
            <button class="overlay-icon" type="button" data-action="more" aria-label="More options">
              ${icon('more', 'filled')}
            </button>
          </div>
        </div>
      </div>
    </div>
    ${(title || creatorName) ? `
      <div class="pin-meta">
        ${title ? `<div class="pin-title">${esc(title)}</div>` : ''}
        ${creatorName ? `
          <div class="pin-creator-row">
            ${creator.image_medium_url
              ? `<img src="${escAttr(creator.image_medium_url)}" alt="">`
              : ''}
            <span class="name">${esc(creatorName)}${adminTick(creator.is_admin)}</span>
          </div>` : ''}
      </div>` : ''}
  `;

  const saveBtn = card.querySelector('.save-pill');
  saveBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    quickSave(pin, saveBtn);
  });
  card.querySelector('[data-action="share"]').addEventListener('click', (event) => {
    event.stopPropagation();
    copyLink(pin);
    toast('Link copied to clipboard');
  });
  card.querySelector('[data-action="more"]').addEventListener('click', (event) => {
    event.stopPropagation();
    openPin(pin.id);
  });
  card.addEventListener('click', () => openPin(pin.id));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPin(pin.id);
    }
  });
  return card;
}

function addPin(pin) {
  if (!pin || state.pinById.has(pin.id)) return;
  state.pins.push(pin);
  state.pinById.set(pin.id, pin);
  const card = createPinCard(pin);
  if (card) {
    state.cardEls.set(pin.id, card);
    placeCard(card);
  }
}

function updateCardSaved(pinId) {
  const pin = state.pinById.get(pinId);
  const card = state.cardEls.get(pinId);
  if (!pin || !card) return;
  const btn = card.querySelector('.save-pill');
  if (!btn) return;
  const saved = Boolean(pin.saved_info?.saved);
  btn.classList.toggle('saved', saved);
  btn.textContent = saved ? 'Saved' : 'Save';
  btn.setAttribute('aria-label', saved ? 'Saved pin' : 'Save pin');
}

// -------------------------------------------------------------------- feed
async function loadFeed(reset = false) {
  if (!reset && state.loading) return;
  if (reset) resetFeed();
  if (!reset && (!state.bookmark || state.bookmark === '-end-')) return;

  state.loading = true;
  const token = state.loadToken;
  $('#loading').classList.remove('hidden');

  try {
    let rr;
    if (state.view === 'search') {
      rr = await resourceGet('ApiResource', {
        url: '/v3/search/',
        data: { query: state.searchTerm },
      });
    } else if (state.view === 'board' && state.board) {
      rr = await resourceGet('BoardFeedResource', {
        board_id: state.board.id,
        page_size: 24,
        bookmarks: reset ? [] : [state.bookmark],
      });
    } else {
      rr = await resourceGet('UserHomefeedResource', {
        field_set_key: 'hf_grid',
        bookmarks: reset ? [] : [state.bookmark],
      });
    }

    if (token !== state.loadToken) return;

    state.bookmark = rr.bookmark ?? '-end-';
    const pins = Array.isArray(rr.data) ? rr.data : [];
    for (const pin of pins) {
      if (pin && pin.type === 'pin') addPin(pin);
    }

    if (state.pins.length) {
      $('#empty').classList.add('hidden');
    } else if (state.view === 'search') {
      renderEmpty('No Pins found', `Nothing matched “${state.searchTerm}”. Try a different search.`);
    } else {
      renderEmpty('Nothing here yet', 'Try refreshing or exploring a different idea.');
    }
  } catch (error) {
    if (token === state.loadToken) {
      renderEmpty('Could not load Pins', 'Please try again in a moment.');
    }
  } finally {
    if (token === state.loadToken) {
      state.loading = false;
      $('#loading').classList.add('hidden');
    }
  }
}

function renderEmpty(title, text) {
  const el = $('#empty');
  el.classList.remove('hidden');
  el.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text || '')}</p>`;
}

// ------------------------------------------------------------------- saving
async function ensureBoards() {
  if (state.boards) return state.boards;
  const rr = await resourceGet('BoardsResource', {
    page_size: 100,
    privacy_filter: 'all',
    sort: 'last_pinned_to',
    username: 'me',
  });
  state.boards = rr.data || [];
  return state.boards;
}

async function loadBoardCovers(boards) {
  const entries = await Promise.all(boards.map(async (board) => {
    try {
      const rr = await resourceGet('BoardFeedResource', {
        board_id: board.id,
        page_size: 3,
      });
      const covers = (rr.data || [])
        .map((pin) => pin.images?.['236x']?.url)
        .filter(Boolean);
      return [board.id, covers];
    } catch {
      return [board.id, []];
    }
  }));
  state.boardCovers = Object.fromEntries(entries);
  return state.boardCovers;
}

async function ensureBoardCovers() {
  if (state.boardCovers) return state.boardCovers;
  const boards = await ensureBoards();
  return loadBoardCovers(boards);
}

async function quickSave(pin, btn) {
  if (pin.saved_info?.saved) {
    toast('Already saved');
    return;
  }

  let boards;
  try {
    boards = await ensureBoards();
  } catch {
    toast('Could not load your boards');
    return;
  }
  if (!boards.length) {
    toast('No boards available');
    return;
  }

  const board = boards[0];
  const previous = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const response = await resourceSend('ApiResource', 'create', {
      url: `/v3/board/${board.id}/pin/${pin.id}/save/`,
      data: {},
    });
    if (response.data?.error) {
      btn.textContent = previous;
      toast(response.data.error);
      return;
    }
    pin.saved_info = { ...(pin.saved_info || {}), saved: true, board_id: board.id };

    const current = state.currentPin;
    if (current && current.id === pin.id) {
      current.saved_info = { ...(current.saved_info || {}), saved: true, board_id: board.id };
      updateModalButtons(current);
    }
    updateCardSaved(pin.id);
    toast(`Saved to ${board.name}`);
  } catch {
    btn.textContent = previous;
    toast('Could not save Pin');
  } finally {
    btn.disabled = false;
  }
}

async function savePinToBoard(pin, boardId) {
  if (!pin) return;
  let boards = [];
  try {
    boards = await ensureBoards();
  } catch { /* keep saving even if the board name is unavailable */ }

  const board = boards.find((item) => String(item.id) === String(boardId));
  try {
    const response = await resourceSend('ApiResource', 'create', {
      url: `/v3/board/${boardId}/pin/${pin.id}/save/`,
      data: {},
    });
    if (response.data?.error) {
      toast(response.data.error);
      return;
    }
    pin.saved_info = { ...(pin.saved_info || {}), saved: true, board_id: boardId };

    const gridPin = state.pinById.get(pin.id);
    if (gridPin) {
      gridPin.saved_info = { ...(gridPin.saved_info || {}), saved: true, board_id: boardId };
    }

    updateCardSaved(pin.id);
    updateModalButtons(pin);
    $('#board-picker').classList.add('hidden');
    toast(board ? `Saved to ${board.name}` : 'Saved');
  } catch {
    toast('Could not save Pin');
  }
}

// ------------------------------------------------------------------ closeup
async function openPin(id) {
  const request = ++pinRequest;
  let pin;
  try {
    const rr = await resourceGet('PinResource', {
      id,
      field_set_key: 'auth_web_main_pin',
    });
    pin = rr.data;
  } catch {
    toast('Could not open this Pin');
    return;
  }
  if (request !== pinRequest || !pin) return;

  state.currentPin = pin;

  const img = pin.images?.['736x'] || pin.images?.['564x'] ||
    pin.images?.['474x'] || pin.images?.['236x'] || pin.images?.orig;
  if (!img || !img.url) {
    toast('This Pin has no image');
    return;
  }

  const title = (pin.closeup_unified_description?.title || pin.title || '').trim();
  const description = (pin.closeup_unified_description?.description || pin.description || '').trim();
  const creator = pin.native_creator || pin.pinner || {};

  $('#modal-img').src = img.url;
  $('#modal-img').alt = title;
  $('#modal-img').style.backgroundColor = pin.dominant_color || '#e9e9e9';

  $('#modal-title').textContent = title;
  $('#modal-title').classList.toggle('hidden', !title);
  $('#modal-desc').textContent = description;
  $('#modal-desc').classList.toggle('hidden', !description);

  $('#modal-avatar').src = creator.image_medium_url || PLACEHOLDER_AVATAR;
  $('#modal-creator').innerHTML =
    `${esc(creator.full_name || creator.username || 'Unknown')}${adminTick(creator.is_admin)}${flagHtml(creator.flags)}`;
  const followers = Number(creator.follower_count);
  $('#modal-followers').textContent = Number.isFinite(followers) && followers >= 0
    ? `${formatCount(followers)} followers` : '';
  $('#modal-creator-row').classList.toggle('hidden', !creator.full_name && !creator.username);
  const followButton = $('#modal-follow');
  const creatorId = creator.id ? String(creator.id) : '';
  const canFollow = Boolean(creatorId) && creatorId !== String(state.me?.id || '');
  followButton.classList.toggle('hidden', !canFollow);
  followButton.disabled = false;
  if (canFollow) {
    const following = Boolean(creator.explicitly_followed_by_me);
    followButton.dataset.userId = creatorId;
    followButton.classList.toggle('following', following);
    followButton.textContent = following ? 'Following' : 'Follow';
  } else {
    followButton.removeAttribute('data-user-id');
    followButton.classList.remove('following');
    followButton.textContent = 'Follow';
  }

  const board = pin.board;
  $('#modal-board-row').classList.toggle('hidden', !board);
  if (board) {
    $('#modal-board').textContent = board.name || '';
    const cover = board.cover_images?.['236x']?.url ||
      board.image_cover_hd_url || board.image_cover_url || img.url;
    const coverEl = $('#modal-board-cover');
    coverEl.src = cover;
    coverEl.onerror = () => { coverEl.src = img.url || PLACEHOLDER_AVATAR; };
  }

  $('#comment-avatar').src = state.me?.image_medium_url || PLACEHOLDER_AVATAR;
  $('#comment-form').querySelector('.comment-send').disabled = false;
  state.comments.set(pin.id, []);
  renderComments(pin.id);
  loadComments(pin.id);
  updateModalStats(pin);
  updateModalButtons(pin);
  $('#board-picker').classList.add('hidden');
  $('#modal-menu').classList.add('hidden');

  $('#modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#modal-close').focus(), 0);
}

async function toggleFollow(button) {
  const userId = button.dataset.userId;
  if (!userId || button.disabled) return;

  const wasFollowing = button.classList.contains('following');
  button.disabled = true;
  try {
    const response = await resourceSend('ApiResource', wasFollowing ? 'update' : 'create', {
      url: `/v3/users/${userId}/${wasFollowing ? 'unfollow' : 'follow'}/`,
      data: {},
    });
    if (response.error || response.data?.error) {
      toast(response.error || response.data.error);
      return;
    }

    const following = Boolean(response.data?.following);
    button.classList.toggle('following', following);
    button.textContent = following ? 'Following' : 'Follow';

    const followers = Number(response.data?.follower_count);
    if (Number.isFinite(followers)) {
      $('#modal-followers').textContent = `${formatCount(followers)} followers`;
    }
    if (state.me && Number.isFinite(Number(response.data?.following_count))) {
      state.me.following_count = Number(response.data.following_count);
    }
    toast(following ? 'Following' : 'Unfollowed');
  } catch {
    toast('Could not update follow');
  } finally {
    button.disabled = false;
  }
}

function closeModal() {
  pinRequest += 1;
  $('#modal').classList.add('hidden');
  $('#board-picker').classList.add('hidden');
  $('#modal-menu').classList.add('hidden');
  document.body.style.overflow = '';
  state.currentPin = null;
}

function updateModalStats(pin) {
  const reactions = Object.values(pin.reaction_counts || {})
    .reduce((sum, count) => sum + (Number(count) || 0), 0);
  const saves = Number(pin.repin_count) || 0;
  const comments = Number(pin.comment_count) || 0;
  $('#modal-stats').textContent =
    `${formatCount(reactions)} reactions · ${formatCount(saves)} saves · ${formatCount(comments)} comments`;
}

function updateModalButtons(pin) {
  const saved = Boolean(pin.saved_info?.saved);
  const saveBtn = $('#btn-save');
  saveBtn.classList.toggle('saved', saved);
  saveBtn.textContent = saved ? 'Saved' : 'Save';

  const reacted = Boolean(pin.saved_info?.reacted);
  const reactBtn = $('#btn-react');
  reactBtn.classList.toggle('reacted', reacted);
  reactBtn.querySelector('span').textContent = reacted ? 'Reacted' : 'React';
}

async function toggleReaction() {
  const pin = state.currentPin;
  if (!pin) return;

  const reacted = Boolean(pin.saved_info?.reacted);
  const btn = $('#btn-react');
  btn.disabled = true;

  try {
    if (reacted) {
      await resourceSend('ApiResource', 'update', {
        url: `/v3/pins/${pin.id}/unreact/`,
        data: {},
      });
      pin.saved_info.reacted = false;
      const count = Number(pin.reaction_counts?.['1']) || 0;
      pin.reaction_counts = { ...(pin.reaction_counts || {}), 1: Math.max(0, count - 1) };
    } else {
      const response = await resourceSend('ApiResource', 'update', {
        url: `/v3/pins/${pin.id}/reaction/`,
        data: { reaction: 1 },
      });
      if (response.data?.error) {
        toast(response.data.error);
        return;
      }
      pin.saved_info.reacted = true;
      const count = Number(pin.reaction_counts?.['1']) || 0;
      pin.reaction_counts = { ...(pin.reaction_counts || {}), 1: count + 1 };
    }

    const gridPin = state.pinById.get(pin.id);
    if (gridPin) {
      gridPin.saved_info = {
        ...(gridPin.saved_info || {}),
        reacted: pin.saved_info.reacted,
      };
    }

    updateModalButtons(pin);
    updateModalStats(pin);
  } catch {
    toast('Could not update reaction');
  } finally {
    btn.disabled = false;
  }
}

// --------------------------------------------------------------- pin menu
// The closeup's "more" menu.  Deleting is offered to the Pin's owner and to
// admins; everyone else only gets the share action.
function canDeletePin(pin) {
  const me = state.me;
  if (!me || !pin) return false;
  if (me.is_admin) return true;
  const owner = pin.pinner || pin.native_creator || {};
  return Boolean(owner.id) && String(owner.id) === String(me.id);
}

function toggleModalMenu() {
  const menu = $('#modal-menu');
  if (!menu.classList.contains('hidden')) {
    menu.classList.add('hidden');
    return;
  }
  const pin = state.currentPin;
  if (!pin) return;
  const items = ['<button class="menu-item" type="button" data-modal-action="copy">Copy link</button>'];
  if (canDeletePin(pin)) {
    items.push('<button class="menu-item danger" type="button" data-modal-action="delete">Delete Pin</button>');
  }
  menu.innerHTML = items.join('');
  menu.classList.remove('hidden');
}

function removePinFromView(pinId) {
  const id = String(pinId);
  const card = state.cardEls.get(pinId);
  if (card) card.remove();
  state.cardEls.delete(pinId);
  state.pinById.delete(pinId);
  state.pins = state.pins.filter((pin) => String(pin.id) !== id);
  state.comments.delete(pinId);
  // Board covers and counts are now stale; rebuild them on the next visit.
  state.boards = null;
  state.boardCovers = null;
  // Pull the remaining cards back up so the grid has no hole where it was.
  const cards = state.pins
    .map((pin) => state.cardEls.get(pin.id))
    .filter(Boolean);
  if (cards.length && state.columns.length) {
    createColumns(state.columns.length);
    for (const el of cards) placeCard(el);
  }
}

async function deleteCurrentPin() {
  const pin = state.currentPin;
  if (!pin) return;
  const confirmed = await confirmAction({
    title: 'Delete Pin',
    desc: 'This Pin will be removed for everyone. This cannot be undone.',
    confirmLabel: 'Delete',
  });
  if (!confirmed) return;

  try {
    const response = await resourceSend('PinResource', 'update', {
      action: 'delete',
      id: pin.id,
    });
    if (response.error || response.data?.error) {
      toast(response.error || response.data?.error);
      return;
    }
    removePinFromView(pin.id);
    closeModal();
    toast('Pin deleted');
  } catch {
    toast('Could not delete this Pin');
  }
}

// ---------------------------------------------------------------- board menu
async function toggleBoardPicker() {
  const picker = $('#board-picker');
  if (!picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    return;
  }

  const pin = state.currentPin;
  if (!pin) return;

  picker.innerHTML = '<div class="bp-title">Loading boards…</div>';
  picker.classList.remove('hidden');

  try {
    const boards = await ensureBoards();
    const covers = await ensureBoardCovers();
    const fallback = pin.images?.['236x']?.url || PLACEHOLDER_AVATAR;
    picker.innerHTML = '<div class="bp-title">Save to board</div>' +
      boards.map((board) => {
        const cover = (covers[board.id] && covers[board.id][0]) ||
          board.cover_images?.['236x']?.url ||
          board.image_cover_url || fallback;
        return `<button class="bp-item" type="button" data-board-id="${escAttr(board.id)}">
          <img src="${escAttr(cover)}" alt="">
          <span class="bp-name">${esc(board.name || 'Untitled board')}</span>
        </button>`;
      }).join('');
  } catch {
    picker.innerHTML = '<div class="bp-title">Could not load boards</div>';
  }
}

// ----------------------------------------------------------------- comments
// Comments live on the server (AggregatedCommentResource) so everyone sees
// them; state.comments only caches the current pin's list.
function commentsOf(pinId) {
  return state.comments.get(pinId) || [];
}

async function loadComments(pinId) {
  try {
    const rr = await resourceGet('AggregatedCommentResource', { pin_id: pinId });
    if (!state.comments.has(pinId)) return; // closeup already closed
    state.comments.set(pinId, Array.isArray(rr.data) ? rr.data : []);
  } catch {
    /* keep whatever list is already rendered */
  }
  renderComments(pinId);
}

function renderComments(pinId) {
  const comments = commentsOf(pinId);
  const list = $('#comment-list');
  list.innerHTML = comments.map((comment) => `
    <div class="comment">
      <img src="${escAttr(comment.user?.image_medium_url || PLACEHOLDER_AVATAR)}" alt="">
      <div class="comment-body">
        <div class="comment-head">
          <span class="comment-name">${esc(comment.user?.full_name || comment.user?.username || 'User')}${adminTick(comment.user?.is_admin)}${flagHtml(comment.user?.flags)}</span>
          ${comment.can_delete ? `<button class="comment-delete" type="button"
            data-comment-id="${escAttr(comment.id)}" aria-label="Delete comment"
            title="Delete comment">${icon('trash')}</button>` : ''}
        </div>
        <div class="comment-text">${esc(comment.text || '')}</div>
      </div>
    </div>`).join('');
  $('#comment-empty').classList.toggle('hidden', comments.length > 0);
}

async function deleteComment(commentId) {
  const pin = state.currentPin;
  if (!pin) return;
  const confirmed = await confirmAction({
    title: 'Delete comment',
    desc: 'This comment will be removed for everyone. This cannot be undone.',
    confirmLabel: 'Delete',
  });
  if (!confirmed) return;

  try {
    const rr = await resourceSend('AggregatedCommentResource', 'update', {
      id: commentId,
      pin_id: pin.id,
    });
    if (rr.error || rr.data?.error) {
      toast(rr.error || rr.data?.error);
      return;
    }
    state.comments.set(
      pin.id,
      commentsOf(pin.id).filter((comment) => String(comment.id) !== String(commentId)),
    );
    renderComments(pin.id);
    if (Number.isFinite(Number(rr.data?.comment_count))) {
      pin.comment_count = Number(rr.data.comment_count);
    } else {
      pin.comment_count = Math.max(0, (Number(pin.comment_count) || 0) - 1);
    }
    updateModalStats(pin);
    toast('Comment deleted');
  } catch {
    toast('Could not delete this comment');
  }
}

async function submitComment(pin) {
  const input = $('#comment-input');
  const text = input.value.trim();
  if (!text) return;

  const button = $('#comment-form').querySelector('.comment-send');
  button.disabled = true;
  try {
    const rr = await resourceSend('AggregatedCommentResource', 'create', {
      pin_id: pin.id,
      text,
    });
    if (rr.error || rr.data?.error) {
      toast(rr.error || rr.data?.error);
      return;
    }
    const comment = rr.data;
    const comments = commentsOf(pin.id);
    comments.unshift(comment);
    state.comments.set(pin.id, comments);
    input.value = '';
    renderComments(pin.id);
    if (Number.isFinite(Number(comment.comment_count))) {
      pin.comment_count = Number(comment.comment_count);
    } else {
      pin.comment_count = (Number(pin.comment_count) || 0) + 1;
    }
    updateModalStats(pin);
  } catch {
    toast('Could not post your comment');
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- typeahead
async function fetchTypeahead(term) {
  try {
    const rr = await resourceGet('AdvancedTypeaheadResource', {
      term,
      pin_scope: 'pins',
      autocomplete_request_surface: 0,
    });
    const items = (rr.data?.items || []).slice(0, 10);
    state.taItems = items;
    state.taIndex = -1;
    renderTypeahead(term, items);
  } catch {
    hideTypeahead();
  }
}

function renderTypeahead(term, items) {
  const el = $('#typeahead');
  el.innerHTML = `
    <div class="ta-header" data-ta-search>
      ${icon('search')}
      <span>Search for “${esc(term)}”</span>
    </div>
    ${items.length ? '<div class="ta-section">Ideas for you</div>' : ''}
    ${items.map((item, index) => {
      const label = (item.label || '').trim() || (item.query || '').trim() || term;
      const media = item.image
        ? `<img class="ta-thumb" src="${escAttr(item.image)}" alt="">`
        : `<span class="ta-icon">${icon(item.type === 'user' ? 'user' : 'search')}</span>`;
      return `<div class="ta-item" data-ta-index="${index}" role="option">
        ${media}
        <span class="ta-label">${esc(label)}${adminTick(item.is_admin)}</span>
        ${item.type === 'user' ? '<span class="ta-type">Profile</span>' : ''}
      </div>`;
    }).join('')}
  `;
  el.classList.remove('hidden');
}

function hideTypeahead() {
  $('#typeahead').classList.add('hidden');
  state.taIndex = -1;
}

function updateTaActive() {
  $$('.ta-item').forEach((item, index) => {
    item.classList.toggle('active', index === state.taIndex);
  });
}

function runSearchItem(item) {
  if (item.type === 'user') {
    const username = (item.query || '').trim();
    hideTypeahead();
    if (username) goUserProfile(username);
    return;
  }
  const term = (item.query || item.label || '').trim();
  if (!term) return;
  $('#search').value = term;
  hideTypeahead();
  goSearch(term);
}

// -------------------------------------------------------------- auth screen
function setAuthTab(tab) {
  const login = tab !== 'signup';
  $$('.auth-tab').forEach((button) => {
    const active = button.dataset.authTab === (login ? 'login' : 'signup');
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#login-form').classList.toggle('hidden', !login);
  $('#signup-form').classList.toggle('hidden', login);
  $('#login-error').classList.add('hidden');
  $('#signup-error').classList.add('hidden');
}

function showAuthError(element, message) {
  element.textContent = message;
  element.classList.remove('hidden');
}

function showAuth(tab = 'login') {
  setPageTitle('');
  document.body.classList.remove('booting');
  document.body.classList.add('auth-mode');
  $('#boot-screen').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  closeModal();
  closeCreate();
  closeProfileEdit();
  closeNetwork();
  state.me = null;
  state.warnings = [];
  state.restriction = null;
  state.boards = null;
  state.boardCovers = null;
  state.currentPin = null;
  state.comments.clear();
  $('#admin-view').classList.add('hidden');
  renderNotices();
  $('#me-avatar').src = PLACEHOLDER_AVATAR;
  $('#comment-avatar').src = PLACEHOLDER_AVATAR;
  resetFeed();
  setAuthTab(tab);
}

function enterApp(session) {
  const data = session || {};
  const user = data.user || data;
  document.body.classList.remove('booting', 'auth-mode');
  $('#boot-screen').classList.add('hidden');
  $('#auth-screen').classList.add('hidden');
  state.me = user || null;
  state.warnings = Array.isArray(data.warnings) ? data.warnings : [];
  state.restriction = data.restriction || null;
  const avatar = state.me?.image_medium_url || PLACEHOLDER_AVATAR;
  $('#me-avatar').src = avatar;
  $('#comment-avatar').src = avatar;
  state.boards = null;
  state.boardCovers = null;
  state.comments.clear();
  updateAdminVisibility();
  renderNotices();
  applyRoute();
}

async function handleAuthSubmit(event, mode) {
  event.preventDefault();
  const errorEl = $(mode === 'login' ? '#login-error' : '#signup-error');
  const submit = event.currentTarget.querySelector('.auth-submit');
  errorEl.classList.add('hidden');

  let payload;
  if (mode === 'login') {
    const identifier = $('#login-identifier').value.trim();
    const password = $('#login-password').value;
    if (!identifier || !password) {
      showAuthError(errorEl, 'Enter your username or email and password.');
      return;
    }
    payload = { mode: 'login', identifier, password };
  } else {
    const fullName = $('#signup-name').value.trim();
    const username = $('#signup-username').value.trim();
    const email = $('#signup-email').value.trim();
    const password = $('#signup-password').value;
    if (!fullName) {
      showAuthError(errorEl, 'Please enter your name.');
      return;
    }
    if (!/^[A-Za-z0-9_.]{3,30}$/.test(username)) {
      showAuthError(errorEl, 'Username must be 3–30 characters using letters, numbers, dots, or underscores.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showAuthError(errorEl, 'Please enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      showAuthError(errorEl, 'Password must be at least 8 characters.');
      return;
    }
    payload = {
      mode: 'signup', full_name: fullName, username, email, password,
    };
  }

  const label = mode === 'login' ? 'Log in' : 'Create account';
  submit.disabled = true;
  submit.textContent = mode === 'login' ? 'Logging in…' : 'Creating account…';

  try {
    const response = await resourceSend('UserSessionResource', 'create', payload);
    const data = response.data || {};
    if (data.authenticated && data.user) {
      $('#login-form').reset();
      $('#signup-form').reset();
      enterApp(data);
      return;
    }
    showAuthError(errorEl, data.error || 'Could not sign you in.');
  } catch {
    showAuthError(errorEl, 'Could not reach the server. Please try again.');
  } finally {
    submit.disabled = false;
    submit.textContent = label;
  }
}

async function logout() {
  try {
    await resourceSend('UserSessionResource', 'update', { action: 'logout' });
  } catch { /* clear the local view even if the request fails */ }
  showAuth('login');
}

// --------------------------------------------------------------- moderation
function updateAdminVisibility() {
  $('#nav-admin').classList.toggle('hidden', !state.me?.is_admin);
}

function isRestricted() {
  return Boolean(state.restriction?.restricted);
}

function restrictionMessage(action = 'do that') {
  const reason = state.restriction?.reason
    ? ` Reason: ${state.restriction.reason}` : '';
  return `Your account is restricted from ${action}.${reason}`;
}

function renderNotices() {
  const el = $('#notice-bar');
  const warnings = state.warnings || [];
  const restriction = state.restriction;
  if (!warnings.length && !restriction?.restricted) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const parts = [];
  if (restriction?.restricted) {
    parts.push(`<div class="notice notice-restrict">
      <strong>Account restricted.</strong>
      <span>${esc(restriction.reason || 'You cannot create, save, or react to Pins right now.')}</span>
    </div>`);
  }
  for (const warning of warnings) {
    parts.push(`<div class="notice notice-warn">
      <strong>Warning from the admin.</strong>
      <span>${esc(warning.message || '')}</span>
      <button type="button" class="notice-ack" data-ack-warning="${escAttr(warning.id)}">Acknowledge</button>
    </div>`);
  }
  el.innerHTML = parts.join('');
  el.classList.remove('hidden');
}

async function acknowledgeWarning(id) {
  try {
    const response = await resourceSend('UserSessionResource', 'update', {
      action: 'ack_warning', warning_id: id,
    });
    if (response.error) throw new Error(response.error);
    state.warnings = (state.warnings || []).filter((warning) => warning.id !== id);
    renderNotices();
    toast('Warning acknowledged');
  } catch {
    toast('Could not acknowledge the warning');
  }
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function adminBadge(label, tone = '') {
  return `<span class="admin-badge ${tone}">${esc(label)}</span>`;
}

function adminLogHtml(entry) {
  const target = entry.target_user
    ? `@${entry.target_user}`
    : (entry.target_pin || '');
  return `<div class="admin-log-entry">
    <div class="admin-log-action">${esc(String(entry.action || '').replace(/_/g, ' '))}</div>
    <div class="admin-log-body">
      <div><b>${esc(entry.actor)}${adminTick(entry.actor_is_admin)}</b>${target ? ` → ${esc(target)}` : ''}</div>
      ${entry.detail ? `<div class="admin-log-detail">${esc(entry.detail)}</div>` : ''}
    </div>
    <time>${esc(formatDate(entry.created_at))}</time>
  </div>`;
}

function adminUserHtml(user) {
  const badges = [];
  if (user.is_banned) badges.push(adminBadge('Banned', 'danger'));
  if (user.is_restricted) badges.push(adminBadge('Restricted', 'warn'));
  if (user.is_demo) badges.push(adminBadge('Demo', 'muted'));
  if (user.warning_count) {
    badges.push(adminBadge(
      `${user.warning_count} warning${user.warning_count === 1 ? '' : 's'}`,
      'warn'));
  }

  const actions = [];
  const isSelf = String(user.id) === String(state.me?.id);
  if (user.is_admin) {
    actions.push(isSelf
      ? '<span class="admin-protected">Protected</span>'
      : `<button class="admin-action danger" data-admin-action="remove_admin" data-user-id="${escAttr(user.id)}">Remove admin</button>`);
  } else {
    if (!user.is_demo) {
      actions.push(`<button class="admin-action" data-admin-action="make_admin" data-user-id="${escAttr(user.id)}">Make admin</button>`);
      actions.push(`<button class="admin-action" data-admin-action="reset_password" data-user-id="${escAttr(user.id)}">Reset password</button>`);
    }
    actions.push(user.is_banned
      ? `<button class="admin-action" data-admin-action="unban" data-user-id="${escAttr(user.id)}">Unban</button>`
      : `<button class="admin-action danger" data-admin-action="ban" data-user-id="${escAttr(user.id)}">Ban</button>`);
    actions.push(user.is_restricted
      ? `<button class="admin-action" data-admin-action="unrestrict" data-user-id="${escAttr(user.id)}">Unrestrict</button>`
      : `<button class="admin-action" data-admin-action="restrict" data-user-id="${escAttr(user.id)}">Restrict</button>`);
    actions.push(`<button class="admin-action" data-admin-action="warn" data-user-id="${escAttr(user.id)}">Warn</button>`);
    actions.push(`<button class="admin-action danger" data-admin-action="delete_user" data-user-id="${escAttr(user.id)}">Delete</button>`);
  }

  const reasons = [];
  if (user.ban_reason) reasons.push(`Ban: ${user.ban_reason}`);
  if (user.restrict_reason) reasons.push(`Restriction: ${user.restrict_reason}`);

  return `<article class="admin-user">
    <img src="${escAttr(user.image_medium_url || PLACEHOLDER_AVATAR)}" alt="">
    <div class="admin-user-info">
      <div class="admin-user-name">${esc(user.full_name)}${adminTick(user.is_admin)}${flagHtml(user.flags)} <span>@${esc(user.username)}</span></div>
      <div class="admin-user-meta">
        ${formatCount(user.pin_count)} Pins ${badges.join('')}
      </div>
      ${reasons.length ? `<div class="admin-user-reason">${esc(reasons.join(' · '))}</div>` : ''}
    </div>
    <div class="admin-actions">${actions.join('')}
      ${user.is_admin ? '' : `<button class="admin-action" data-admin-action="edit_user" data-user-id="${escAttr(user.id)}">Edit</button>`}
    </div>
  </article>`;
}

function adminPinHtml(pin) {
  return `<article class="admin-pin">
    <img src="${escAttr(pin.image_url || PLACEHOLDER_AVATAR)}" alt="">
    <div class="admin-pin-body">
      <div class="admin-pin-title">${esc(pin.title || pin.description || 'Untitled Pin')}</div>
      <div class="admin-pin-meta">@${esc(pin.pinner_username || 'unknown')}${pin.board_name ? ` · ${esc(pin.board_name)}` : ''}</div>
      <div class="admin-pin-actions">
        ${adminBadge(pin.is_created ? 'Created' : 'Seed', pin.is_created ? 'muted' : '')}
        <button class="admin-action danger" data-admin-action="delete_pin" data-pin-id="${escAttr(pin.id)}">Delete</button>
      </div>
    </div>
  </article>`;
}

function renderAdminOverview(overview) {
  const counts = overview?.counts || {};
  const recent = overview?.recent || [];
  const cards = [
    ['Accounts', counts.accounts],
    ['Demo accounts', counts.demo_accounts],
    ['Admins', counts.admins],
    ['Banned', counts.banned],
    ['Restricted', counts.restricted],
    ['Open warnings', counts.warnings],
    ['Pins', counts.pins],
    ['Created Pins', counts.created_pins],
    ['Moderation actions', counts.actions],
  ];
  return `
    <div class="admin-stats">
      ${cards.map(([label, value]) => `<div class="admin-stat">
        <b>${formatCount(value || 0)}</b><span>${esc(label)}</span>
      </div>`).join('')}
    </div>
    <h2 class="admin-section-title">Recent moderation</h2>
    ${recent.length
      ? `<div class="admin-log">${recent.map(adminLogHtml).join('')}</div>`
      : '<p class="admin-empty">No moderation actions yet.</p>'}
  `;
}

function renderAdmin(tab, overview, section) {
  const el = $('#admin-view');
  const tabs = [
    ['overview', 'Overview'],
    ['users', 'Accounts'],
    ['pins', 'Pins'],
    ['log', 'Log'],
  ];
  if (tab === 'users') state.adminUsers = Array.isArray(section) ? section : [];
  if (tab === 'pins') state.adminPins = Array.isArray(section) ? section : [];

  el.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Admin</h1>
        <p>Moderate accounts and Pins in this instance.</p>
      </div>
      <button class="admin-refresh" id="admin-refresh" type="button">Refresh</button>
    </div>
    <div class="admin-tabs">
      ${tabs.map(([key, label]) => `<button
        class="admin-tab ${key === tab ? 'active' : ''}" type="button"
        data-admin-tab="${key}">${label}</button>`).join('')}
    </div>
    ${tab === 'overview' ? renderAdminOverview(overview) : ''}
    ${tab === 'users' ? `
      <div class="admin-list">
        ${state.adminUsers.length
          ? state.adminUsers.map(adminUserHtml).join('')
          : '<p class="admin-empty">No accounts found.</p>'}
      </div>` : ''}
    ${tab === 'pins' ? `
      <div class="admin-pins">
        ${state.adminPins.length
          ? state.adminPins.map(adminPinHtml).join('')
          : '<p class="admin-empty">No Pins found.</p>'}
      </div>` : ''}
    ${tab === 'log' ? (Array.isArray(section) && section.length
      ? `<div class="admin-log">${section.map(adminLogHtml).join('')}</div>`
      : '<p class="admin-empty">No moderation actions yet.</p>') : ''}
  `;
}

async function loadAdmin(tab = 'overview') {
  if (!state.me?.is_admin) {
    toast('Admins only');
    return;
  }
  state.adminTab = tab;
  state.view = 'admin';
  profileToken += 1;
  setActiveNav(null);
  $('#feed').classList.add('hidden');
  $('#profile-view').classList.add('hidden');
  $('#page-head').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#loading').classList.add('hidden');
  $('#admin-view').classList.remove('hidden');

  const el = $('#admin-view');
  el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const [overviewRR, sectionRR] = await Promise.all([
      resourceGet('AdminResource', { section: 'overview' }),
      tab === 'overview'
        ? Promise.resolve({ data: null })
        : resourceGet('AdminResource', { section: tab }),
    ]);
    if (state.view !== 'admin' || state.adminTab !== tab) return;
    if (overviewRR.error || sectionRR.error) {
      el.innerHTML = `<div class="empty"><h2>Admins only</h2>
        <p>${esc(overviewRR.error || sectionRR.error)}</p></div>`;
      return;
    }
    renderAdmin(tab, overviewRR.data, sectionRR.data);
  } catch {
    el.innerHTML = `<div class="empty"><h2>Could not load admin tools</h2>
      <p>Please try again.</p></div>`;
  }
}

function goAdmin(tab = 'overview') {
  if (!state.me?.is_admin) {
    toast('Admins only');
    return;
  }
  const key = ADMIN_PATHS[tab] ? tab : 'overview';
  pushPath(ADMIN_PATHS[key]);
  setPageTitle(ADMIN_TITLES[key]);
  loadAdmin(key);
}

const ADMIN_SUCCESS = {
  ban: 'Account banned',
  unban: 'Account unbanned',
  restrict: 'Account restricted',
  unrestrict: 'Account restriction removed',
  warn: 'Warning sent',
  delete_user: 'Account deleted',
  delete_pin: 'Pin deleted',
  edit_user: 'Account updated',
  reset_password: 'Password reset',
  make_admin: 'Account promoted to admin',
  remove_admin: 'Admin access removed',
};

function showAdminDialogError(message) {
  const el = $('#admin-dialog-error');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function closeAdminDialog() {
  $('#admin-dialog').classList.add('hidden');
  $('#admin-dialog-card').innerHTML = '';
  state.adminPending = null;
  state.adminFlags = new Set();
  document.body.style.overflow = '';
}

function openAdminDialog(action, target) {
  const isUser = ['ban', 'restrict', 'warn', 'delete_user', 'reset_password']
    .includes(action);
  const name = isUser
    ? `@${target.username}`
    : (target.title || target.description || 'this Pin');
  const configs = {
    ban: ['Ban account',
      `Ban ${name}? They will be signed out and blocked from logging in.`,
      'Ban account', [['Reason (optional)', 'reason']]],
    restrict: ['Restrict account',
      `Restrict ${name}? They can still browse, but cannot create, save, or react to Pins.`,
      'Restrict account', [['Reason (optional)', 'reason']]],
    warn: ['Warn account',
      `Send a warning to ${name}. It appears at the top of their screen until acknowledged.`,
      'Send warning', [['Warning message', 'message']]],
    delete_user: ['Delete account',
      `Permanently delete ${name} and all of their Pins and boards?`,
      'Delete account', [['Reason (optional)', 'reason']]],
    delete_pin: ['Delete Pin',
      `Permanently delete ${name}?`,
      'Delete Pin', [['Reason (optional)', 'reason']]],
    edit_user: ['Edit account',
      `Edit ${name}'s profile information. Changes apply immediately and are logged.`,
      'Save changes',
      [['Full name', 'full_name'], ['Username', 'username'], ['About', 'about']]],
    reset_password: ['Reset password',
      `Generate a new 10-character password for ${name}? Their current sessions will be signed out.`,
      'Reset password', []],
  };
  const config = configs[action];
  if (!config) return;
  const [title, description, confirmLabel, fields] = config;
  const danger = ['ban', 'delete_user', 'delete_pin'].includes(action);

  // Staff edits are not the account holder changing their own handle, so the
  // 7-day username window neither applies nor starts here.
  const editing = action === 'edit_user';
  state.adminFlags = new Set(
    editing ? (Array.isArray(target.flags) ? target.flags : []).filter((id) => FLAGS[id]).slice(0, 4) : [],
  );

  $('#admin-dialog-card').innerHTML = `
    <button class="modal-close" data-admin-close aria-label="Close">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
    <h2 class="admin-dialog-title">${esc(title)}</h2>
    <p class="admin-dialog-desc">${esc(description)}</p>
    ${fields.map(([fieldLabel, fieldName]) => `
      <label class="admin-field">
        <span>${esc(fieldLabel)}</span>
        ${fieldName === 'about'
          ? `<textarea id="admin-${fieldName}" maxlength="500" rows="3">${esc(editing ? (target[fieldName] || '') : '')}</textarea>`
          : `<input id="admin-${fieldName}" type="text"
                    maxlength="${fieldName === 'username' ? 30 : 200}"
                    value="${escAttr(editing ? (target[fieldName] || '') : '')}">`}
        ${editing && fieldName === 'username'
          ? '<small class="flag-hint">Staff edits skip the 7-day limit and do not start one.</small>'
          : ''}
      </label>
    `).join('')}
    ${editing ? `
      <div class="admin-field">
        <span>Gender flags <small id="admin-flag-count" class="flag-count">${state.adminFlags.size}/4</small></span>
        <div id="admin-flag-picker" class="flag-picker" role="group"
             aria-label="Gender flags">${flagPickerHtml(state.adminFlags)}</div>
        <small class="flag-hint">Pick up to 4 flags to show next to their name.</small>
      </div>` : ''}
    <div class="admin-dialog-error hidden" id="admin-dialog-error"></div>
    <div class="admin-dialog-actions">
      <button type="button" class="create-cancel" data-admin-close>Cancel</button>
      <button type="button" class="admin-confirm ${danger ? 'danger' : ''}"
              id="admin-confirm">${esc(confirmLabel)}</button>
    </div>
  `;

  state.adminPending = { action, target, fields };
  $('#admin-dialog').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('#admin-confirm').addEventListener('click', submitAdminDialog);
  $('#admin-flag-picker')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-flag-id]');
    if (!option) return;
    const id = option.dataset.flagId;
    if (state.adminFlags.has(id)) {
      state.adminFlags.delete(id);
    } else {
      if (state.adminFlags.size >= 4) {
        toast('You can pick up to 4 flags');
        return;
      }
      state.adminFlags.add(id);
    }
    $('#admin-flag-picker').innerHTML = flagPickerHtml(state.adminFlags);
    $('#admin-flag-count').textContent = `${state.adminFlags.size}/4`;
  });
  const firstTextarea = $('#admin-full_name');
  if (firstTextarea) firstTextarea.focus();
}

function showResetPasswordResult(target, password) {
  $('#admin-dialog-card').innerHTML = `
    <button class="modal-close" data-admin-close aria-label="Close">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
    <h2 class="admin-dialog-title">Password reset</h2>
    <p class="admin-dialog-desc">Give this password to @${esc(target.username)}. It will not be shown again.</p>
    <div class="admin-password">${esc(password)}</div>
    <div class="admin-dialog-actions">
      <button type="button" class="create-cancel" id="admin-copy-password">Copy</button>
      <button type="button" class="admin-confirm" data-admin-close>Done</button>
    </div>
  `;
  state.adminPending = null;
  $('#admin-copy-password').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast('Password copied');
    } catch {
      toast('Could not copy — select the password and copy it manually');
    }
  });
}

async function submitAdminDialog() {
  const pending = state.adminPending;
  if (!pending) return;

  // Collect values from all fields
  const fieldValues = {};
  pending.fields.forEach(([fieldLabel, fieldName]) => {
    const el = $('#admin-' + fieldName);
    if (el) {
      fieldValues[fieldName] = el.value.trim();
    }
  });

  const button = $('#admin-confirm');
  button.disabled = true;
  button.textContent = 'Working…';

  const options = { action: pending.action };
  if (pending.action === 'delete_pin') options.pin_id = pending.target.id;
  else options.user_id = pending.target.id;

  // Pass all field values for edit_user
  if (pending.action === 'edit_user') {
    options.full_name = fieldValues.full_name || pending.target.full_name;
    options.username = fieldValues.username || pending.target.username;
    options.about = fieldValues.about || pending.target.about;
    // Always send the set, so clearing every flag is a real change.
    options.flags = [...(state.adminFlags || [])].slice(0, 4);
  } else {
    // reason / message for ban, restrict, warn, delete
    Object.assign(options, fieldValues);
  }

  try {
    const response = await resourceSend('AdminResource', 'create', options);
    if (response.error) {
      showAdminDialogError(response.error);
      button.disabled = false;
      button.textContent = 'Try again';
      return;
    }
    if (pending.action === 'reset_password' && response.data?.password) {
      toast(ADMIN_SUCCESS[pending.action] || 'Done');
      showResetPasswordResult(pending.target, response.data.password);
      await loadAdmin(state.adminTab);
      return;
    }
    closeAdminDialog();
    toast(ADMIN_SUCCESS[pending.action] || 'Done');
    await loadAdmin(state.adminTab);
  } catch {
    showAdminDialogError('Could not reach the server. Please try again.');
    button.disabled = false;
    button.textContent = 'Try again';
  }
}

async function runAdminAction(action, options) {
  try {
    const response = await resourceSend('AdminResource', 'create', {
      action, ...options,
    });
    if (response.error) {
      toast(response.error);
      return;
    }
    toast(ADMIN_SUCCESS[action] || 'Done');
    await loadAdmin(state.adminTab);
  } catch {
    toast('Could not update the account');
  }
}

function handleAdminClick(event) {
  const tab = event.target.closest('[data-admin-tab]');
  if (tab) {
    goAdmin(tab.dataset.adminTab);
    return;
  }
  if (event.target.closest('#admin-refresh')) {
    loadAdmin(state.adminTab);
    return;
  }
  const button = event.target.closest('[data-admin-action]');
  if (!button) return;
  const action = button.dataset.adminAction;
  if (action === 'delete_pin') {
    const pin = (state.adminPins || [])
      .find((item) => item.id === button.dataset.pinId);
    if (pin) openAdminDialog(action, pin);
    return;
  }
  const user = (state.adminUsers || [])
    .find((item) => item.id === button.dataset.userId);
  if (!user) return;
  if (action === 'edit_user') {
    openAdminDialog(action, user);
    return;
  }
  if (action === 'unban' || action === 'unrestrict'
      || action === 'make_admin' || action === 'remove_admin') {
    runAdminAction(action, { user_id: user.id });
    return;
  }
  openAdminDialog(action, user);
}

// ---------------------------------------------------------------- create pin
function showCreateError(message) {
  const el = $('#create-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function resetCreateForm() {
  createImage = null;
  $('#create-form').reset();
  $('#create-error').classList.add('hidden');
  const preview = $('#create-preview');
  preview.classList.add('hidden');
  preview.removeAttribute('src');
  $('#create-drop-inner').classList.remove('hidden');
  $('#create-file').value = '';
  const submit = $('#create-submit');
  submit.disabled = true;
  submit.textContent = 'Publish';
}

async function loadCreateBoards() {
  let boards = state.boards;
  if (!boards) {
    const response = await resourceGet('BoardsResource', {
      page_size: 100, privacy_filter: 'all', sort: 'last_pinned_to', username: 'me',
    });
    boards = response.data || [];
    state.boards = boards;
  }
  const select = $('#create-board');
  select.innerHTML = boards
    .map((board) => `<option value="${escAttr(board.id)}">${esc(board.name || 'Untitled board')}</option>`)
    .join('');
  if (!boards.length) {
    showCreateError('Create a board before publishing a Pin.');
  }
}

async function openCreate() {
  if (isRestricted()) {
    toast(restrictionMessage('creating Pins'));
    return;
  }
  resetCreateForm();
  $('#create-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('#create-menu').classList.add('hidden');
  $('#nav-create').setAttribute('aria-expanded', 'false');
  try {
    await loadCreateBoards();
  } catch {
    showCreateError('Could not load your boards. Please try again.');
  }
  $('#create-title').focus();
}

function closeCreate() {
  $('#create-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

function readCreateImage(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    showCreateError('Choose a PNG, JPG, WebP, or GIF image.');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showCreateError('Images must be 8 MB or smaller.');
    return;
  }

  const reader = new FileReader();
  reader.onerror = () => showCreateError('Could not read that image.');
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    const image = new Image();
    image.onload = () => {
      createImage = {
        dataUrl,
        width: image.naturalWidth || 1000,
        height: image.naturalHeight || 1000,
      };
      const preview = $('#create-preview');
      preview.src = dataUrl;
      preview.classList.remove('hidden');
      $('#create-drop-inner').classList.add('hidden');
      $('#create-error').classList.add('hidden');
      $('#create-submit').disabled = false;
    };
    image.onerror = () => showCreateError('That file does not look like a valid image.');
    image.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

async function submitCreate(event) {
  event.preventDefault();
  if (!createImage) {
    showCreateError('Choose an image for your Pin.');
    return;
  }
  const boardId = $('#create-board').value;
  if (!boardId) {
    showCreateError('Create a board before publishing a Pin.');
    return;
  }

  const submit = $('#create-submit');
  submit.disabled = true;
  submit.textContent = 'Publishing…';
  $('#create-error').classList.add('hidden');

  try {
    const response = await resourceSend('PinResource', 'create', {
      title: $('#create-title').value.trim(),
      description: $('#create-description').value.trim(),
      board_id: boardId,
      image: createImage.dataUrl,
      width: createImage.width,
      height: createImage.height,
    });
    if (response.data?.id) {
      closeCreate();
      state.boards = null;
      state.boardCovers = null;
      toast('Pin published');
      goHome();
      return;
    }
    showCreateError(response.error || 'Could not publish your Pin.');
  } catch {
    showCreateError('Could not reach the server. Please try again.');
  }

  submit.disabled = false;
  submit.textContent = 'Publish';
}

// --------------------------------------------------------------- navigation
function pushPath(path) {
  const current = `${location.pathname}${location.search}`;
  if (current === path) return;
  history.pushState({ path }, '', path);
}

function setPageTitle(label) {
  document.title = label ? `${label} · Tseretnip` : 'Tseretnip';
}

// Render the view that matches the current URL. Entry views call pushPath, but
// since the URL already matches there is no extra history entry.
function applyRoute() {
  if (!state.me) return;
  const path = location.pathname.replace(/\/+$/, '') || '/';

  if (path === '/explore') {
    goExplore();
    return;
  }
  if (path === '/profile') {
    goProfile();
    return;
  }
  if (path === '/search') {
    const term = new URLSearchParams(location.search).get('q') || '';
    if (term) {
      goSearch(term);
      return;
    }
  }
  if (path === '/admin' || path.startsWith('/admin/')) {
    if (!state.me.is_admin) {
      history.replaceState({}, '', '/');
      toast('Admins only');
      goHome();
      return;
    }
    const tab = ADMIN_ROUTE_TABS[path] || 'overview';
    if (path !== ADMIN_PATHS[tab]) {
      history.replaceState({}, '', ADMIN_PATHS[tab]);
    }
    goAdmin(tab);
    return;
  }
  // Anything else that is a single segment is a public profile URL
  // (e.g. /somebody/), served by the same app shell.
  const segment = path.slice(1);
  if (segment && !segment.includes('/')) {
    goUserProfile(decodeURIComponent(segment));
    return;
  }
  goHome();
}

function setActiveNav(which) {
  $('#nav-home').classList.toggle('active', which === 'home');
  $('#nav-explore').classList.toggle('active', which === 'explore');
}

function showFeed() {
  $('#admin-view').classList.add('hidden');
  $('#profile-view').classList.add('hidden');
  $('#feed').classList.remove('hidden');
  $('#empty').classList.add('hidden');
  $('#loading').classList.add('hidden');
}

function showProfile() {
  $('#admin-view').classList.add('hidden');
  $('#feed').classList.add('hidden');
  $('#page-head').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#loading').classList.add('hidden');
  $('#profile-view').classList.remove('hidden');
}

function renderPageHead({ title, sub, chips, active, back } = {}) {
  const el = $('#page-head');
  if (!title && !sub && !chips && !back) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    ${back ? '<button class="back-btn" type="button" id="page-back">← Back</button>' : ''}
    ${(title || sub) ? `<div class="page-title-row">
      ${title ? `<h1 class="page-title">${esc(title)}</h1>` : ''}
      ${sub ? `<span class="page-sub">${esc(sub)}</span>` : ''}
    </div>` : ''}
    ${chips ? `<div class="filter-bar">${chips.map((chip) => `
      <button class="chip ${chip === active ? 'active' : ''}" type="button"
              data-chip="${escAttr(chip)}">${esc(chip)}</button>`).join('')}
    </div>` : ''}
  `;
}

function goHome() {
  pushPath('/');
  setPageTitle('');
  profileToken += 1;
  state.view = 'home';
  state.searchTerm = '';
  state.board = null;
  setActiveNav('home');
  showFeed();
  $('#page-head').classList.add('hidden');
  $('#search').value = '';
  hideTypeahead();
  loadFeed(true);
}

function goExplore() {
  pushPath('/explore');
  setPageTitle('Explore');
  profileToken += 1;
  state.view = 'explore';
  state.searchTerm = '';
  state.board = null;
  setActiveNav('explore');
  showFeed();
  renderPageHead({ title: 'Explore', chips: EXPLORE_CHIPS, active: 'All' });
  loadFeed(true);
}

function goSearch(term) {
  pushPath(`/search?q=${encodeURIComponent(term)}`);
  setPageTitle(term ? `Search: ${term}` : 'Search');
  profileToken += 1;
  state.view = 'search';
  state.searchTerm = term;
  state.board = null;
  setActiveNav(null);
  showFeed();
  $('#search').value = term;
  renderPageHead({ chips: SEARCH_CHIPS, active: 'All Pins' });
  loadFeed(true);
}

async function goProfile() {
  pushPath('/profile');
  loadProfile(null);
}

// Public profile page for any account (also reached from search typeahead and
// the closeup creator row).
function goUserProfile(username) {
  pushPath(`/${encodeURIComponent(username)}`);
  loadProfile(username);
}

async function loadProfile(username = null) {
  profileToken += 1;
  const token = profileToken;
  state.profileUsername = username;
  state.view = 'profile';
  state.board = null;
  state.searchTerm = '';
  setActiveNav(null);
  showProfile();
  setPageTitle(username ? `@${username}` : 'Your profile');

  const isOwn = !username;
  const el = $('#profile-view');
  el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

  try {
    const [userRR, boardsRR] = await Promise.all([
      resourceGet('UserResource', {
        username: username || 'me',
        field_set_key: 'profile',
      }),
      resourceGet('BoardsResource', {
        page_size: 100,
        privacy_filter: 'all',
        sort: 'last_pinned_to',
        username: username || 'me',
      }),
    ]);
    if (token !== profileToken) return;

    if (!userRR.data) {
      el.innerHTML = `<div class="empty"><h2>Profile not found</h2>
        <p>No account named “${esc(username || '')}” exists on this instance.</p></div>`;
      return;
    }

    const user = userRR.data;
    const boards = boardsRR.data || [];
    if (isOwn) {
      state.me = user;
      state.boards = boards;
      $('#me-avatar').src = user.image_medium_url || PLACEHOLDER_AVATAR;
    }

    const covers = await loadBoardCovers(boards);
    if (token !== profileToken) return;
    renderProfile(user, boards, covers, isOwn);
  } catch {
    if (token === profileToken) {
      el.innerHTML = '<div class="empty"><h2>Could not load profile</h2><p>Please try again.</p></div>';
    }
  }
}

function renderProfile(user, boards, covers, isOwn) {
  const el = $('#profile-view');
  const name = user.full_name || user.username || 'You';
  const handle = user.username ? `@${user.username}` : '';
  const following = Boolean(user.explicitly_followed_by_me);

  el.innerHTML = `
    <div class="profile-head">
      <img class="profile-avatar" src="${escAttr(user.image_medium_url || PLACEHOLDER_AVATAR)}" alt="">
      <h1 class="profile-name">${esc(name)}${adminTick(user.is_admin)}${flagHtml(user.flags)}</h1>
      ${handle ? `<div class="profile-handle">${esc(handle)}</div>` : ''}
      ${user.about ? `<p class="profile-bio">${esc(user.about)}</p>` : ''}
      <div class="profile-stats">
        <button type="button" class="stat-btn" data-network="followers">
          <b>${formatCount(user.follower_count)}</b> followers</button>
        <button type="button" class="stat-btn" data-network="following">
          <b>${formatCount(user.following_count)}</b> following</button>
        <span><b>${formatCount(user.pin_count)}</b> Pins</span>
      </div>
      <div class="profile-actions">
        <button type="button" id="profile-share">Share</button>
        ${isOwn ? `
          <button type="button" id="profile-edit">Edit profile</button>
          ${state.me?.is_admin ? '<button type="button" id="profile-admin" class="profile-admin">Admin</button>' : ''}
          <button type="button" id="profile-logout">Log out</button>` : `
          <button type="button" class="follow-btn profile-follow ${following ? 'following' : ''}"
                  id="profile-follow" data-user-id="${escAttr(user.id)}">
            ${following ? 'Following' : 'Follow'}</button>`}
      </div>
    </div>
    <div class="profile-tabs">
      <button class="profile-tab active" type="button">Boards</button>
    </div>
    <div class="board-grid">
      ${boards.length
        ? boards.map((board) => boardCardHtml(board, covers[board.id] || [])).join('')
        : '<p class="admin-empty">No boards yet.</p>'}
    </div>
  `;

  $('#profile-share').addEventListener('click', async () => {
    const url = isOwn
      ? `${location.origin}/profile`
      : `${location.origin}/${encodeURIComponent(user.username)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch { /* clipboard may be unavailable */ }
    toast('Profile link copied');
  });
  if (isOwn) {
    $('#profile-edit').addEventListener('click', openProfileEdit);
    $('#profile-admin')?.addEventListener('click', () => goAdmin('overview'));
    $('#profile-logout').addEventListener('click', logout);
  } else {
    $('#profile-follow').addEventListener('click', async (event) => {
      const data = await followToggle(event.currentTarget);
      if (data && Number.isFinite(Number(data.follower_count))) {
        const btn = el.querySelector('[data-network="followers"]');
        if (btn) btn.innerHTML =
          `<b>${formatCount(data.follower_count)}</b> followers`;
      }
    });
  }

  $$('.stat-btn', el).forEach((button) => {
    button.addEventListener('click', () => {
      openNetwork(user, button.dataset.network);
    });
  });

  $$('.board-card', el).forEach((card) => {
    card.addEventListener('click', () => {
      const board = boards.find((item) => String(item.id) === card.dataset.boardId);
      if (board) openBoard(board);
    });
  });
}

// Shared follow/unfollow for the profile page and the followers/following
// modal.  Returns the response so callers can update counters.
async function followToggle(button) {
  const userId = button.dataset.userId;
  if (!userId || button.disabled) return null;

  const wasFollowing = button.classList.contains('following');
  button.disabled = true;
  try {
    const rr = await resourceSend('ApiResource', wasFollowing ? 'update' : 'create', {
      url: `/v3/users/${userId}/${wasFollowing ? 'unfollow' : 'follow'}/`,
      data: {},
    });
    if (rr.error || rr.data?.error) {
      toast(rr.error || rr.data?.error);
      return null;
    }
    const following = Boolean(rr.data?.following);
    button.classList.toggle('following', following);
    button.textContent = following ? 'Following' : 'Follow';
    toast(following ? 'Following' : 'Unfollowed');
    return rr.data;
  } catch {
    toast('Could not update follow');
    return null;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------- followers / following
async function openNetwork(user, list) {
  state.networkUser = user;
  $('#network-title').textContent = list === 'following'
    ? `Following · @${user.username}`
    : `Followers · @${user.username}`;
  const listEl = $('#network-list');
  listEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  $('#network-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  try {
    const rr = await resourceGet('UserNetworkResource', {
      username: user.username,
      list,
    });
    if (state.networkUser?.id !== user.id) return;
    const people = Array.isArray(rr.data) ? rr.data : [];
    listEl.innerHTML = people.length
      ? people.map(networkRowHtml).join('')
      : `<p class="admin-empty">No ${list === 'following' ? 'follows' : 'followers'} yet.</p>`;
  } catch {
    listEl.innerHTML = '<p class="admin-empty">Could not load the list.</p>';
  }
}

function networkRowHtml(person) {
  const isYou = Boolean(person.is_you) ||
    String(person.id) === String(state.me?.id);
  const followBtn = isYou ? '' : `
    <button type="button" class="follow-btn small ${person.explicitly_followed_by_me ? 'following' : ''}"
            data-network-follow="${escAttr(person.id)}">
      ${person.explicitly_followed_by_me ? 'Following' : 'Follow'}
    </button>`;
  return `<div class="network-row" data-network-user="${escAttr(person.username || '')}" ${isYou ? '' : 'role="link"'}>
    <img src="${escAttr(person.image_medium_url || PLACEHOLDER_AVATAR)}" alt="">
    <div class="network-info">
      <div class="network-name">${esc(person.full_name || person.username || 'User')}${adminTick(person.is_admin)}${flagHtml(person.flags)}${isYou ? '<span class="network-you"> (you)</span>' : ''}</div>
      <div class="network-handle">@${esc(person.username || '')}</div>
    </div>
    ${followBtn}
  </div>`;
}

function closeNetwork() {
  $('#network-modal').classList.add('hidden');
  document.body.style.overflow = '';
  state.networkUser = null;
}

// ------------------------------------------------------------- edit profile
function showProfileError(message) {
  const el = $('#profile-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function openProfileEdit() {
  const me = state.me || {};
  profileEditImage = null;
  $('#profile-edit-avatar').src = me.image_medium_url || PLACEHOLDER_AVATAR;
  $('#profile-edit-name').value = me.full_name || '';
  $('#profile-edit-username').value = me.username || '';
  $('#profile-edit-about').value = me.about || '';
  $('#profile-edit-file').value = '';
  $('#profile-error').classList.add('hidden');
  renderUsernameCooldown(me);
  state.flagSelection = new Set((me.flags || []).filter((id) => FLAGS[id]).slice(0, 4));
  renderFlagPicker();
  const save = $('#profile-save');
  save.disabled = false;
  save.textContent = 'Save changes';
  $('#profile-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('#profile-edit-name').focus();
}

// Usernames may change once every 7 days.  While the window is closed the
// field stays readable but not editable, and the hint says when it reopens;
// the server enforces the same rule.
function renderUsernameCooldown(me) {
  const availableAt = me?.username_change_available_at || null;
  const unlock = availableAt ? new Date(availableAt).getTime() : 0;
  const locked = Number.isFinite(unlock) && unlock > Date.now();
  const input = $('#profile-edit-username');
  input.readOnly = locked;
  input.title = locked
    ? `You can change your username again on ${formatDay(availableAt)}.`
    : '';
  $('#profile-username-hint').textContent = locked
    ? `You can change your username again on ${formatDay(availableAt)}.`
    : 'You can change your username once every 7 days.';
}

// Shared by the account holder's edit form and the admin panel's account
// editor, so both offer the same vocabulary and the same 4-flag cap.
function flagPickerHtml(selection) {
  return Object.entries(FLAGS).map(([id, flag]) => {
    const on = selection.has(id);
    return `<button type="button" class="flag-option ${on ? 'selected' : ''}"
            data-flag-id="${escAttr(id)}" title="${esc(flag.label)}"
            aria-pressed="${on}">
      <span class="flag" style="${flagGradient(id)}"></span>
      <span class="flag-label">${esc(flag.label)}</span>
    </button>`;
  }).join('');
}

function renderFlagPicker() {
  $('#flag-picker').innerHTML = flagPickerHtml(state.flagSelection);
  $('#flag-count').textContent = `${state.flagSelection.size}/4`;
}

function closeProfileEdit() {
  $('#profile-modal').classList.add('hidden');
  document.body.style.overflow = '';
  profileEditImage = null;
}

function readProfileImage(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    showProfileError('Choose a PNG, JPG, WebP, or GIF image.');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showProfileError('Images must be 8 MB or smaller.');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => showProfileError('Could not read that image.');
  reader.onload = () => {
    profileEditImage = String(reader.result || '');
    $('#profile-edit-avatar').src = profileEditImage;
    $('#profile-error').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

async function submitProfileEdit(event) {
  event.preventDefault();
  const fullName = $('#profile-edit-name').value.trim();
  const username = $('#profile-edit-username').value.trim();
  const about = $('#profile-edit-about').value.trim();

  if (!fullName) {
    showProfileError('Enter your name.');
    return;
  }
  if (!/^[A-Za-z0-9_.]{3,30}$/.test(username)) {
    showProfileError('Username must be 3-30 characters using letters, numbers, dots, or underscores.');
    return;
  }

  // The server enforces the 7-day window too; catching it here avoids a round
  // trip and gives the same date the hint shows.
  const currentUsername = String(state.me?.username || '');
  const usernameAvailableAt = state.me?.username_change_available_at || null;
  if (username.toLowerCase() !== currentUsername.toLowerCase()
      && usernameAvailableAt
      && new Date(usernameAvailableAt).getTime() > Date.now()) {
    showProfileError(`You can change your username again on ${formatDay(usernameAvailableAt)}.`);
    return;
  }

  const save = $('#profile-save');
  save.disabled = true;
  save.textContent = 'Saving…';
  $('#profile-error').classList.add('hidden');

  const payload = {
    action: 'update_profile',
    full_name: fullName,
    username,
    about,
    flags: [...state.flagSelection].slice(0, 4),
  };
  if (profileEditImage) payload.image = profileEditImage;

  try {
    const response = await resourceSend('UserSessionResource', 'update', payload);
    if (response.error) {
      showProfileError(response.error);
      save.disabled = false;
      save.textContent = 'Save changes';
      return;
    }
    if (response.data?.user) {
      state.me = { ...(state.me || {}), ...response.data.user };
    } else {
      state.me = { ...(state.me || {}), full_name: fullName, username, about };
    }
    const avatar = state.me?.image_medium_url || PLACEHOLDER_AVATAR;
    $('#me-avatar').src = avatar;
    $('#comment-avatar').src = avatar;
    closeProfileEdit();
    toast('Profile updated');
    goProfile();
  } catch {
    showProfileError('Could not reach the server. Please try again.');
    save.disabled = false;
    save.textContent = 'Save changes';
  }
}

function boardCardHtml(board, covers) {
  const images = (covers || []).slice(0, 3);
  const count = images.length;
  const cover = count
    ? `<div class="board-cover-collage count-${count}">
        ${images.map((url) => `<img src="${escAttr(url)}" alt="">`).join('')}
      </div>`
    : '<div class="board-cover-collage empty-cover">No cover yet</div>';

  const owner = board.owner || {};
  const ownerName = owner.full_name || owner.username || '';

  return `<article class="board-card" data-board-id="${escAttr(board.id)}">
    ${cover}
    <h3>${esc(board.name || 'Untitled board')}</h3>
    <p>${formatCount(board.pin_count || 0)} ${Number(board.pin_count) === 1 ? 'Pin' : 'Pins'}${ownerName ? ` · ${esc(ownerName)}` : ''}</p>
  </article>`;
}

function openBoard(board) {
  profileToken += 1;
  state.view = 'board';
  state.board = board;
  state.searchTerm = '';
  setActiveNav(null);
  showFeed();
  renderPageHead({
    title: board.name || 'Board',
    sub: `${formatCount(board.pin_count || 0)} ${Number(board.pin_count) === 1 ? 'Pin' : 'Pins'}`,
    back: true,
  });
  $('#page-back')?.addEventListener('click', () => {
    if (state.profileUsername) goUserProfile(state.profileUsername);
    else goProfile();
  });
  loadFeed(true);
}

// ---------------------------------------------------------------- confirm
// Small promise-based confirmation dialog, used by destructive actions that
// belong to the account holder (deleting a Pin or a comment) rather than to
// moderation.
let confirmResolve = null;

function confirmAction({ title, desc, confirmLabel = 'Delete' } = {}) {
  return new Promise((resolve) => {
    if (confirmResolve) confirmResolve(false);
    confirmResolve = resolve;
    $('#confirm-title').textContent = title || 'Are you sure?';
    $('#confirm-desc').textContent = desc || '';
    $('#confirm-ok').textContent = confirmLabel;
    $('#confirm-modal').classList.remove('hidden');
    $('#confirm-ok').focus();
  });
}

function closeConfirm(result = false) {
  $('#confirm-modal').classList.add('hidden');
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(result);
}

// -------------------------------------------------------------------- toast
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

async function copyLink(pin) {
  const url = `${location.origin}/?pin=${encodeURIComponent(pin.id)}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch { /* clipboard may be unavailable */ }
}

// ------------------------------------------------------------------ helpers
function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(n);
}

function formatDay(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function escAttr(value) {
  return esc(value);
}

// ------------------------------------------------------------------- events
function wireEvents() {
  $('#auth-screen').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-auth-tab]');
    if (tab) setAuthTab(tab.dataset.authTab);
  });
  $('#login-form').addEventListener('submit', (event) => handleAuthSubmit(event, 'login'));
  $('#signup-form').addEventListener('submit', (event) => handleAuthSubmit(event, 'signup'));

  $('#nav-logo').addEventListener('click', (event) => {
    event.preventDefault();
    goHome();
  });
  $('#nav-home').addEventListener('click', goHome);
  $('#nav-explore').addEventListener('click', goExplore);
  $('#nav-profile').addEventListener('click', goProfile);
  $('#nav-admin').addEventListener('click', () => goAdmin('overview'));
  $('#nav-notifications').addEventListener('click', () => toast("You're all caught up"));
  $('#nav-messages').addEventListener('click', () => toast('No new messages'));

  $('#notice-bar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-ack-warning]');
    if (button) acknowledgeWarning(button.dataset.ackWarning);
  });
  $('#admin-view').addEventListener('click', handleAdminClick);
  $('#admin-dialog').addEventListener('click', (event) => {
    if (event.target.closest('[data-admin-close]')) closeAdminDialog();
  });

  $('#profile-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-profile-close]')) closeProfileEdit();
  });
  $('#profile-form').addEventListener('submit', submitProfileEdit);
  $('#profile-edit-file').addEventListener('change', (event) => {
    readProfileImage(event.target.files?.[0]);
  });

  $('#nav-create').addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('#create-menu');
    const open = menu.classList.toggle('hidden');
    $('#nav-create').setAttribute('aria-expanded', String(!open));
  });
  $('#nav-create-mobile').addEventListener('click', openCreate);
  $('#create-menu').addEventListener('click', (event) => {
    const item = event.target.closest('.menu-item');
    if (!item) return;
    const kind = item.dataset.create;
    $('#create-menu').classList.add('hidden');
    $('#nav-create').setAttribute('aria-expanded', 'false');
    if (kind === 'pin') {
      openCreate();
      return;
    }
    toast(`Creating a ${kind === 'idea' ? 'Idea Pin' : kind} is not part of this instance`);
  });

  $('#create-close').addEventListener('click', closeCreate);
  $('#create-cancel').addEventListener('click', closeCreate);
  $('#create-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-create-close]')) closeCreate();
  });
  $('#create-form').addEventListener('submit', submitCreate);
  $('#create-file').addEventListener('change', (event) => {
    readCreateImage(event.target.files?.[0]);
  });

  const drop = $('#create-drop');
  ['dragenter', 'dragover'].forEach((name) => {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((name) => {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove('dragover');
    });
  });
  drop.addEventListener('drop', (event) => {
    readCreateImage(event.dataTransfer?.files?.[0]);
  });

  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const term = $('#search').value.trim();
    if (!term) return;
    hideTypeahead();
    goSearch(term);
  });

  $('#search').addEventListener('input', (event) => {
    clearTimeout(taTimer);
    const term = event.target.value.trim();
    if (!term) {
      hideTypeahead();
      return;
    }
    taTimer = setTimeout(() => fetchTypeahead(term), 180);
  });

  $('#search').addEventListener('focus', () => {
    const term = $('#search').value.trim();
    if (term && $('#typeahead').classList.contains('hidden')) fetchTypeahead(term);
  });

  $('#search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideTypeahead();
      return;
    }
    if ($('#typeahead').classList.contains('hidden') || !state.taItems.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      state.taIndex = (state.taIndex + direction + state.taItems.length) % state.taItems.length;
      updateTaActive();
    } else if (event.key === 'Enter' && state.taIndex >= 0) {
      event.preventDefault();
      runSearchItem(state.taItems[state.taIndex]);
    }
  });

  $('#typeahead').addEventListener('click', (event) => {
    if (event.target.closest('[data-ta-search]')) {
      const term = $('#search').value.trim();
      if (term) {
        hideTypeahead();
        goSearch(term);
      }
      return;
    }
    const item = event.target.closest('.ta-item');
    if (!item) return;
    const index = Number(item.dataset.taIndex);
    const data = state.taItems[index];
    if (data) runSearchItem(data);
  });

  $('#page-head').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const label = chip.dataset.chip;

    if (state.view === 'explore') {
      if (label === 'All') goExplore();
      else goSearch(label);
    } else if (state.view === 'search') {
      if (label !== 'All Pins') {
        toast('Only Pin results are available in this instance');
      }
    }
  });

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', closeModal);
  $('#modal-share').addEventListener('click', () => {
    if (state.currentPin) copyLink(state.currentPin);
    toast('Link copied to clipboard');
  });
  $('#modal-more').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleModalMenu();
  });

  $('#modal-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-modal-action]');
    if (!item) return;
    event.stopPropagation();
    $('#modal-menu').classList.add('hidden');
    if (item.dataset.modalAction === 'copy') {
      if (state.currentPin) copyLink(state.currentPin);
      toast('Link copied to clipboard');
    } else if (item.dataset.modalAction === 'delete') {
      deleteCurrentPin();
    }
  });

  $('#comment-list').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-comment-id]');
    if (!btn) return;
    deleteComment(btn.dataset.commentId);
  });

  $('#confirm-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-confirm-close]')) {
      closeConfirm(false);
      return;
    }
    if (event.target.closest('#confirm-ok')) closeConfirm(true);
  });
  $('#modal-follow').addEventListener('click', (event) => {
    toggleFollow(event.currentTarget);
  });

  $('#btn-react').addEventListener('click', toggleReaction);
  $('#btn-save').addEventListener('click', toggleBoardPicker);

  $('#board-picker').addEventListener('click', (event) => {
    const item = event.target.closest('.bp-item');
    if (!item) return;
    savePinToBoard(state.currentPin, item.dataset.boardId);
  });

  $('#comment-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.currentPin) submitComment(state.currentPin);
  });

  // Clicking the creator in a closeup opens their public profile.
  $('#modal-creator-row').addEventListener('click', (event) => {
    if (event.target.closest('#modal-follow')) return;
    const creator = state.currentPin?.native_creator || state.currentPin?.pinner;
    if (creator?.username) {
      closeModal();
      goUserProfile(creator.username);
    }
  });

  $('#network-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-network-close]')) {
      closeNetwork();
      return;
    }
    const followBtn = event.target.closest('[data-network-follow]');
    if (followBtn) {
      event.stopPropagation();
      followToggle(followBtn);
      return;
    }
    const row = event.target.closest('[data-network-user]');
    if (row) {
      closeNetwork();
      goUserProfile(row.dataset.networkUser);
    }
  });

  $('#flag-picker').addEventListener('click', (event) => {
    const option = event.target.closest('[data-flag-id]');
    if (!option) return;
    const id = option.dataset.flagId;
    if (state.flagSelection.has(id)) {
      state.flagSelection.delete(id);
    } else {
      if (state.flagSelection.size >= 4) {
        toast('You can pick up to 4 flags');
        return;
      }
      state.flagSelection.add(id);
    }
    renderFlagPicker();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search-wrap')) hideTypeahead();
    if (!event.target.closest('.create-wrap')) {
      $('#create-menu').classList.add('hidden');
      $('#nav-create').setAttribute('aria-expanded', 'false');
    }
    if (!event.target.closest('.save-wrap')) {
      $('#board-picker').classList.add('hidden');
    }
    if (!event.target.closest('#modal-menu')) {
      $('#modal-menu').classList.add('hidden');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#confirm-modal').classList.contains('hidden')) closeConfirm(false);
      else if (!$('#admin-dialog').classList.contains('hidden')) closeAdminDialog();
      else if (!$('#network-modal').classList.contains('hidden')) closeNetwork();
      else if (!$('#profile-modal').classList.contains('hidden')) closeProfileEdit();
      else if (!$('#create-modal').classList.contains('hidden')) closeCreate();
      else if (!$('#modal').classList.contains('hidden')) closeModal();
      else hideTypeahead();
    }
  });

  window.addEventListener('scroll', () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (state.view === 'profile' || state.view === 'admin') return;
      const nearBottom = window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 900;
      if (nearBottom) loadFeed(false);
    });
  }, { passive: true });

  window.addEventListener('popstate', () => {
    applyRoute();
  });

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view !== 'profile' && state.view !== 'admin') relayout();
    }, 120);
  });
}

// --------------------------------------------------------------------- boot
async function init() {
  $('#me-avatar').src = PLACEHOLDER_AVATAR;
  $('#comment-avatar').src = PLACEHOLDER_AVATAR;
  wireEvents();
  createColumns(columnCount());

  try {
    const response = await resourceGet('UserSessionResource', {});
    const data = response.data || {};
    if (data.authenticated && data.user) enterApp(data);
    else showAuth('login');
  } catch {
    showAuth('login');
  }

  const pinParam = new URLSearchParams(location.search).get('pin');
  if (pinParam && state.me) openPin(pinParam);
}

init();
