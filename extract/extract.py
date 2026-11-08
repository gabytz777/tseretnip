#!/usr/bin/env python3
"""Extract seed data and embedded images from the Pinterest HAR capture.

Produces:
  extract/images/            - all embedded i.pinimg.com images, named by URL path
  extract/images_index.json  - URL -> local filename mapping with dimensions
  extract/seed.json          - pins, boards, users and the static resource blobs
                               distilled from the HAR's resource responses

Only public page data is kept. Cookies, auth tokens, recaptcha/fingerprint
payloads, e-mail addresses and tracking parameters are dropped before anything
is written.  The seed is a *distillation* of the API contract, not a copy of
Pinterest's proprietary frontend bundle.
"""

import base64
import json
import os
import re
import sys
from urllib.parse import urlparse

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
HAR_PATH = sys.argv[1] if len(sys.argv) > 1 else \
    os.path.join(os.path.dirname(OUT_DIR), 'capture.har')
IMG_DIR = os.path.join(OUT_DIR, 'images')
INDEX_PATH = os.path.join(OUT_DIR, 'images_index.json')
SEED_PATH = os.path.join(OUT_DIR, 'seed.json')

# Keys that must never leave the HAR.  Matched case-insensitively against the
# key name, recursively, for every object we persist.
SECRET_KEY_RE = re.compile(
    r'(cookie|token|password|passwd|authorization|client_secret|secret_key|recaptcha|fingerprint|tracking)',
    re.I,
)

# Values that look like tracking blobs but do not carry the word "tracking".
DROP_KEYS = {'email', 'client_tracking_params', 'tracking_params'}

used_files = set()


def local_img(url):
    """Return the local /img/... path for a captured URL and mark it used."""
    if not isinstance(url, str):
        return None
    hit = images_index.get(url)
    if not hit:
        return None
    used_files.add(hit['file'])
    return '/img/' + hit['file']


def keep_remote_or_none(url):
    """For avatars/covers: keep a captured local file, otherwise drop remote
    Pinterest CDN URLs so the instance stays self-contained (the UI falls back to
    a placeholder).  Non-Pinterest URLs are left alone."""
    if not isinstance(url, str):
        return url
    local = local_img(url)
    if local:
        return local
    if 'pinimg.com' in url:
        return None
    return url


def clean(obj):
    """Deep-copy an object while dropping secret/tracking keys."""
    if isinstance(obj, dict):
        out = {}
        for key, value in obj.items():
            if key in DROP_KEYS or key == 'secret' or SECRET_KEY_RE.search(key):
                continue
            out[key] = clean(value)
        return out
    if isinstance(obj, list):
        return [clean(value) for value in obj]
    return obj


def rewrite_image_urls(obj):
    """Recursively replace captured image URLs with local paths."""
    if isinstance(obj, dict):
        return {key: rewrite_image_urls(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [rewrite_image_urls(value) for value in obj]
    if isinstance(obj, str):
        local = local_img(obj)
        return local or obj
    return obj


def sanitize_user(user):
    if not isinstance(user, dict):
        return user
    user = clean(user)
    for key in ('image_medium_url', 'image_small_url', 'image_large_url',
                'image_xlarge_url', 'image_square_url', 'image'):
        if key in user:
            user[key] = keep_remote_or_none(user[key])
    return user


def sanitize_board(board):
    if not isinstance(board, dict):
        return board
    board = clean(board)
    for key in ('image_cover_url', 'image_cover_hd_url', 'image_thumbnail_url'):
        if key in board:
            board[key] = keep_remote_or_none(board[key])
    if 'owner' in board:
        board['owner'] = sanitize_user(board['owner'])
    for key in ('cover_images', 'images'):
        value = board.get(key)
        if isinstance(value, dict):
            for variant, image in value.items():
                if isinstance(image, list):
                    for item in image:
                        if isinstance(item, dict) and item.get('url'):
                            item['url'] = local_img(item['url']) or item['url']
                elif isinstance(image, dict) and image.get('url'):
                    image['url'] = local_img(image['url']) or image['url']
    return board


def sanitize_pin(pin):
    if not isinstance(pin, dict):
        return pin
    pin = clean(pin)

    images = pin.get('images') or {}
    fallback = None
    for key in ('236x', '170x', '474x', '564x', '736x', 'orig', '1200x'):
        image = images.get(key)
        if isinstance(image, dict):
            fallback = local_img(image.get('url'))
            if fallback:
                break
    for image in images.values():
        if isinstance(image, dict) and image.get('url'):
            image['url'] = local_img(image['url']) or fallback or image['url']

    if 'board' in pin:
        pin['board'] = sanitize_board(pin['board'])
    for key in ('pinner', 'native_creator', 'closeup_unified_attribution'):
        if key in pin:
            pin[key] = sanitize_user(pin[key])
    return pin


def main():
    global images_index
    with open(HAR_PATH) as handle:
        har = json.load(handle)
    entries = har['log']['entries']

    # ---- 1. embedded images -------------------------------------------------
    os.makedirs(IMG_DIR, exist_ok=True)
    images_index = {}
    for entry in entries:
        url = urlparse(entry['request']['url'])
        if 'i.pinimg.com' not in url.netloc:
            continue
        content = entry['response']['content']
        text = content.get('text')
        if not text:
            continue
        rel = url.path.lstrip('/')                       # 236x/10/18/3e/abc.jpg
        safe = rel.replace('/', '_')
        out_path = os.path.join(IMG_DIR, safe)
        if content.get('encoding') == 'base64':
            data = base64.b64decode(text)
        else:
            data = text.encode('utf-8')
        with open(out_path, 'wb') as image_file:
            image_file.write(data)
        images_index[entry['request']['url']] = {
            'file': safe,
            'mimeType': content.get('mimeType', 'image/jpeg'),
            'size': len(data),
        }
    print(f'extracted {len(images_index)} images -> {IMG_DIR}')

    # ---- 2. seed data from resource responses -------------------------------
    seed = {
        'version': 2,
        'pins': {},
        'boards': {},
        'users': {},
        'feed_order': [],
        'user_profile': None,
        'me': None,
        'profile_boards': [],
        'profile_meta': {},
        'search_tab': None,
        'typeahead_items': [],
        'ghost_queries': [],
        'experiences': {},
        'experiences_multi': {},
        'gen_ai_interests': [],
        'recent_engaged_stories': [],
        'news_hub': None,
        'save_behavior': None,
        'user_metadata': None,
        'session': None,
        'batch': None,
        'activate_experiments': None,
    }
    seen_feed = set()

    for entry in entries:
        url = urlparse(entry['request']['url'])
        if url.netloc != 'ro.pinterest.com':
            continue
        body = entry['response']['content'].get('text')
        if not body or 'json' not in entry['response']['content'].get('mimeType', ''):
            continue
        try:
            document = json.loads(body)
        except Exception:
            continue
        response = document.get('resource_response') or {}
        resource = document.get('resource') or {}
        name = resource.get('name', '')
        options = resource.get('options') or {}
        data = response.get('data')

        if name == 'UserHomefeedResource' and isinstance(data, list):
            for node in data:
                if node.get('type') != 'pin':
                    continue
                pin_id = str(node.get('id'))
                if pin_id in seen_feed:
                    continue
                seen_feed.add(pin_id)
                seed['feed_order'].append(pin_id)
                seed['pins'][pin_id] = distill_pin(node)
                for user_key in ('pinner', 'native_creator'):
                    user = node.get(user_key)
                    if user and user.get('id'):
                        seed['users'][str(user['id'])] = distill_user(user)
                board = node.get('board')
                if board and board.get('id'):
                    seed['boards'][str(board['id'])] = distill_board(board)

        elif name == 'UserResource':
            field_set = options.get('field_set_key')
            if field_set == 'profile' and isinstance(data, dict):
                seed['user_profile'] = distill_user(data)
                seed['users'][str(data.get('id'))] = distill_user(data)
            elif field_set == 'save_behavior' and isinstance(data, dict):
                seed['save_behavior'] = clean(data)

        elif name == 'BoardsResource' and isinstance(data, list):
            for board in data:
                if board.get('id'):
                    distilled = distill_board(board)
                    # BoardsResource does not echo the owner, but this is the
                    # profile board request -> it belongs to the profile user.
                    distilled['owner_username'] = options.get('username')
                    seed['boards'][str(board['id'])] = distilled
                    seed['profile_boards'].append(distilled)

        elif name == 'SearchTabResource':
            seed['search_tab'] = clean(rewrite_image_urls(data))

        elif name == 'AdvancedTypeaheadResource' and isinstance(data, dict):
            seed['typeahead_items'] = clean(rewrite_image_urls(data.get('items') or []))

        elif name == 'ConversationsResource':
            pass  # empty in this capture

        elif name == 'NewsHubBadgeResource' and isinstance(data, dict):
            seed['news_hub'] = clean(data)

        elif name == 'UserSessionResource' and isinstance(data, dict):
            # Never store session accounts/tokens; the mock login rebuilds this.
            seed['session'] = {'success': bool(data.get('success'))}

        elif name == 'ActivateExperimentResource' and isinstance(data, list):
            seed['activate_experiments'] = clean(data)

        elif name == 'UserExperiencePlatformResource':
            if options.get('multiExperiencePlatform'):
                seed['experiences_multi'] = clean(rewrite_image_urls(data or {}))
            else:
                seed['experiences'] = clean(rewrite_image_urls(data or {}))

        elif name == 'ApiResource' and isinstance(data, (dict, list)):
            inner = options.get('url', '')
            if inner == '/v3/users/me/':
                # The real response contains an e-mail address.  Keep only the
                # non-identifying fields; the mock server generates a fake one.
                safe = {key: value for key, value in data.items()
                        if key not in ('email',)}
                seed['me'] = clean(safe)
            elif inner.endswith('/metadata/'):
                seed['user_metadata'] = clean(data)
            elif inner == '/v3/users/me/recent/engaged/pin/stories/':
                seed['recent_engaged_stories'] = clean(rewrite_image_urls(data))
            elif inner == '/v3/search/ghost_queries/':
                seed['ghost_queries'] = clean(rewrite_image_urls(data))
            elif inner == '/v3/users/settings/gen_ai/':
                seed['gen_ai_interests'] = clean(rewrite_image_urls(data))
            elif inner == '/v3/batch/':
                seed['batch'] = clean(rewrite_image_urls(data))

    # If the profile response was missing, fall back to the batch response.
    if not seed['user_profile'] and isinstance(seed['batch'], dict):
        for value in seed['batch'].values():
            user = value.get('data') if isinstance(value, dict) else None
            if isinstance(user, dict) and user.get('username'):
                seed['user_profile'] = distill_user(user)
                seed['users'][str(user.get('id'))] = distill_user(user)

    me = seed['user_profile'] or {}
    me_id = str(me.get('id')) if me.get('id') else None
    if me_id:
        seed['me'] = {
            'id': me_id,
            'full_name': me.get('full_name'),
            'first_name': me.get('first_name'),
            'username': me.get('username'),
        }

    # The profile board response omits its owner; attach the profile user.
    for board in seed['profile_boards']:
        if board.get('owner_username') and me.get('username') == board['owner_username']:
            board['owner_id'] = me_id
            raw = seed['boards'][board['id']].get('raw')
            if isinstance(raw, dict) and me_id:
                raw['owner'] = seed['users'].get(me_id, {}).get('raw')

    # ---- 3. write outputs ---------------------------------------------------
    with open(INDEX_PATH, 'w') as handle:
        json.dump(images_index, handle, indent=1)
    with open(SEED_PATH, 'w') as handle:
        json.dump(seed, handle, indent=1, ensure_ascii=False)

    assert_no_secrets(seed)

    print(f"seed: {len(seed['pins'])} pins, "
          f"{len(seed['boards'])} boards, {len(seed['users'])} users, "
          f"profile={'yes' if seed['user_profile'] else 'no'}")
    print(f"      search_tab={'yes' if seed['search_tab'] else 'no'}, "
          f"typeahead={len(seed['typeahead_items'])}, "
          f"experiences={len(seed['experiences'])}")


def distill_pin(node):
    """Column-friendly view + a sanitized copy of the original pin node."""
    raw = sanitize_pin(node)
    images = {}
    for key, image in (raw.get('images') or {}).items():
        images[key] = {
            'width': image.get('width'),
            'height': image.get('height'),
            'url': image.get('url'),
        }
    board = raw.get('board') or {}
    return {
        'id': str(raw.get('id')),
        'title': raw.get('grid_title') or raw.get('title') or '',
        'description': raw.get('description') or '',
        'dominant_color': raw.get('dominant_color'),
        'created_at': raw.get('created_at'),
        'is_video': raw.get('is_video', False),
        'link': raw.get('link'),
        'domain': raw.get('domain'),
        'images': images,
        'image_signature': raw.get('image_signature'),
        'repin_count': raw.get('repin_count', 0),
        'comment_count': raw.get('comment_count', 0),
        'reaction_counts': raw.get('reaction_counts', {}),
        'board_id': str(board.get('id')) if board.get('id') else None,
        'board_name': board.get('name') if board.get('name') else None,
        'pinner_id': str((raw.get('pinner') or {}).get('id'))
        if raw.get('pinner') else None,
        'native_creator_id': str((raw.get('native_creator') or {}).get('id'))
        if raw.get('native_creator') else None,
        'source': 'har',
        'raw': raw,
    }


def distill_user(user):
    raw = sanitize_user(user)
    return {
        'id': str(raw.get('id')),
        'username': raw.get('username'),
        'full_name': raw.get('full_name'),
        'first_name': raw.get('first_name'),
        'image_medium_url': raw.get('image_medium_url'),
        'image_small_url': raw.get('image_small_url'),
        'image_large_url': raw.get('image_large_url'),
        'image_xlarge_url': raw.get('image_xlarge_url'),
        'about': raw.get('about'),
        'country': raw.get('country'),
        'follower_count': raw.get('follower_count'),
        'following_count': raw.get('following_count'),
        'board_count': raw.get('board_count'),
        'pin_count': raw.get('pin_count'),
        'type': 'user',
        'raw': raw,
    }


def distill_board(board):
    raw = sanitize_board(board)
    owner = raw.get('owner') or {}
    return {
        'id': str(raw.get('id')),
        'name': raw.get('name'),
        'url': raw.get('url'),
        'pin_count': raw.get('pin_count'),
        'image_cover_hd_url': raw.get('image_cover_hd_url'),
        'image_cover_url': raw.get('image_cover_url'),
        'image_thumbnail_url': raw.get('image_thumbnail_url'),
        'collaborator_count': raw.get('collaborator_count', 0),
        'is_collaborative': raw.get('is_collaborative', False),
        'board_order_modified_at': raw.get('board_order_modified_at'),
        'owner_id': str(owner.get('id')) if owner.get('id') else None,
        'type': 'board',
        'raw': raw,
    }


def assert_no_secrets(value, path='seed'):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in DROP_KEYS or key == 'secret' or SECRET_KEY_RE.search(key):
                raise SystemExit(f'refusing to write secret-looking key: {path}.{key}')
            assert_no_secrets(child, f'{path}.{key}')
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_secrets(child, f'{path}[{index}]')


if __name__ == '__main__':
    main()
