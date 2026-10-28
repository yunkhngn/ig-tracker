import fs from 'fs';
import vm from 'vm';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };

// ---- Pull the real source out of the files, don't reimplement it ----
const dash = fs.readFileSync('dashboard/dashboard.js', 'utf8');
const slice = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`cannot slice ${from}`);
  return src.slice(a, b);
};

const escSrc = slice(dash, '  const HTML_ESCAPES = {', '  // --- Init ---');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(escSrc + '\n;globalThis.escapeHtml=escapeHtml;globalThis.profileUrl=profileUrl;', ctx);
const { escapeHtml, profileUrl } = ctx;

console.log('escapeHtml / profileUrl (from dashboard.js):');
check('escapes double quote', escapeHtml('a"b') === 'a&quot;b', escapeHtml('a"b'));
check('escapes single quote', escapeHtml("a'b") === 'a&#39;b', escapeHtml("a'b"));
check('escapes angle brackets', escapeHtml('<img>') === '&lt;img&gt;');
check('escapes ampersand first', escapeHtml('&lt;') === '&amp;lt;', escapeHtml('&lt;'));
check('handles null/undefined', escapeHtml(null) === '' && escapeHtml(undefined) === '');

// The actual attack: a full_name that breaks out of an attribute
const evil = '" onmouseover="alert(1)';
const attr = `data-fullname="${escapeHtml(evil)}"`;
check('full_name cannot break out of attribute', !/onmouseover=/.test(attr.replace(/&quot;/g, '')) === false
      ? !attr.includes('" onmouseover') : true, attr);
check('no raw quote survives in attribute', !attr.slice(15, -1).includes('"'), attr);

// href injection
check('href encodes quotes', !escapeHtml(profileUrl('bad"user')).includes('"'), profileUrl('bad"user'));
check('href encodes slashes/path traversal', profileUrl('a/../../evil') === 'https://instagram.com/a%2F..%2F..%2Fevil',
      profileUrl('a/../../evil'));
check('normal username untouched', profileUrl('yun.khngn') === 'https://instagram.com/yun.khngn');

// ---- fetchList pagination guards (real source from content.js) ----
const content = fs.readFileSync('content/content.js', 'utf8');
let fetchSrc = slice(content, '  // Sleep helper', '  // Message handler')
  .replace('[30000, 60000, 120000]', '[5, 10, 20]'); // shrink waits for the test

let calls = [];
const stub = {
  console,
  chrome: { runtime: { sendMessage: async () => {} } },
  Math, Set, String, Promise, setTimeout,
};
stub.igFetch = async (url) => {
  calls.push(url);
  return stub._responder(url, calls.length);
};
vm.createContext(stub);
vm.runInContext(fetchSrc + '\n;globalThis.fetchList=fetchList;', stub);

console.log('\nfetchList (from content.js):');

// normal pagination terminates
calls = [];
stub._responder = (u, n) => n < 3
  ? { users: [{ pk: n, username: `u${n}` }], next_max_id: `cur${n}` }
  : { users: [{ pk: n, username: `u${n}` }] };
let list = await stub.fetchList('1', 'followers', 3);
check('walks all pages then stops', list.length === 3 && calls.length === 3, `${list.length}/${calls.length}`);
check('drops profile_pic_url', !('profile_pic_url' in list[0]), Object.keys(list[0]).join(','));

// repeating cursor must not spin forever
calls = [];
stub._responder = (n) => ({ users: [{ pk: 1, username: 'loop' }], next_max_id: 'SAME' });
list = await stub.fetchList('1', 'followers', 0);
check('repeated cursor breaks the loop', calls.length === 2, `made ${calls.length} calls`);

// rate limit is retried, not fatal
calls = [];
let thrown = 0;
let page = 0;
stub._responder = (u) => {
  // page 2 is rate-limited twice, then succeeds
  if (u.includes('max_id') && thrown < 2) { thrown++; throw new Error('RATE_LIMITED'); }
  page++;
  return page < 2
    ? { users: [{ pk: page, username: `u${page}` }], next_max_id: `c${page}` }
    : { users: [{ pk: 99, username: 'last' }] };
};
list = await stub.fetchList('1', 'followers', 0);
check('429 mid-fetch retries and keeps earlier pages', list.length >= 1 && thrown === 2, `len=${list.length} retries=${thrown}`);

// exhausted retries still throw
calls = [];
stub._responder = () => { throw new Error('RATE_LIMITED'); };
let err = null;
try { await stub.fetchList('1', 'followers', 0); } catch (e) { err = e.message; }
check('gives up after max retries', err === 'RATE_LIMITED', String(err));

// non-rate-limit errors are not retried
calls = [];
stub._responder = () => { throw new Error('NOT_LOGGED_IN'); };
err = null;
try { await stub.fetchList('1', 'followers', 0); } catch (e) { err = e.message; }
check('auth error fails fast (no backoff)', err === 'NOT_LOGGED_IN' && calls.length === 1, `${err} after ${calls.length}`);

// max_id cursor must be URL-encoded
calls = [];
stub._responder = (u, n) => n < 2
  ? { users: [{ pk: 1, username: 'u1' }], next_max_id: 'cursor+with/equals==' }
  : { users: [{ pk: 2, username: 'u2' }] };
list = await stub.fetchList('1', 'followers', 2);
check('max_id is URL-encoded in query', calls[1] && calls[1].includes('max_id=cursor%2Bwith%2Fequals%3D%3D'), calls[1]);

// deduplicates users across pages
calls = [];
stub._responder = (u, n) => n < 2
  ? { users: [{ pk: 1, username: 'u1' }, { pk: 2, username: 'u2' }], next_max_id: 'c1' }
  : { users: [{ pk: 2, username: 'u2' }, { pk: 3, username: 'u3' }] };
list = await stub.fetchList('1', 'followers', 3);
check('deduplicates user IDs across pages', list.length === 3, `got ${list.length}`);

// rank_token and search_surface included and consistent across pages
calls = [];
stub._responder = (u, n) => n < 2
  ? { users: [{ pk: 1, username: 'u1' }], next_max_id: 'c1' }
  : { users: [{ pk: 2, username: 'u2' }] };
list = await stub.fetchList('1', 'followers', 2);
const rankMatch0 = calls[0]?.match(/rank_token=([^&]+)/);
const rankMatch1 = calls[1]?.match(/rank_token=([^&]+)/);
check('rank_token present in query', Boolean(rankMatch0));
check('search_surface=follow_list_page present', calls[0]?.includes('search_surface=follow_list_page'));
check('rank_token is identical across pagination pages', rankMatch0 && rankMatch1 && rankMatch0[1] === rankMatch1[1]);
check('isComplete true when list matches expected total', list.isComplete === true);

// isComplete false when list terminates prematurely
calls = [];
stub._responder = () => ({ users: [{ pk: 1, username: 'only_one' }] }); // No next_max_id, only 1 user returned
list = await stub.fetchList('1', 'followers', 100);
check('isComplete false when only 1 out of 100 followers fetched', list.isComplete === false, String(list.isComplete));

// handles users with missing pk without "undefined" collision
calls = [];
stub._responder = () => ({
  users: [
    { username: 'user_a' },
    { pk: null, username: 'user_b' },
    { username: 'user_c' }
  ]
});
list = await stub.fetchList('1', 'followers', 3);
check('all users with missing pk preserved without collision', list.length === 3, `got ${list.length}`);
check('no user has id "undefined"', !list.some(u => u.id === 'undefined'));

// short first walk triggers a second pass with a new rank_token, merged
calls = [];
stub._responder = (u, n) => n === 1
  ? { users: Array.from({ length: 50 }, (_, i) => ({ pk: i, username: `a${i}` })) }
  : { users: Array.from({ length: 100 }, (_, i) => ({ pk: i, username: `a${i}` })) };
list = await stub.fetchList('1', 'followers', 100, true);
const tok = (c) => c?.match(/rank_token=([^&]+)/)?.[1];
check('short scan re-walks the list', calls.length === 2 && list.length === 100, `${calls.length} calls, ${list.length} users`);
check('second pass uses a fresh rank_token', tok(calls[0]) !== tok(calls[1]));
check('merged result is complete', list.isComplete === true);

// other people's lists: no second walk
calls = [];
list = await stub.fetchList('1', 'followers', 100, false);
check('no re-walk for other accounts', calls.length === 1, `${calls.length} calls`);

// ---- reconcileWithPrevious: missing users are checked, not assumed gone ----
vm.runInContext('globalThis.reconcileWithPrevious=reconcileWithPrevious;', stub);
stub.isAuthOrRateLimitError = (e) => ['NOT_LOGGED_IN', 'RATE_LIMITED', 'CHECKPOINT_REQUIRED'].includes(e?.message);

calls = [];
stub._responder = (u) => {
  // "skipped" is still following; "gone" really unfollowed
  if (u.includes('query=skipped')) return { users: [{ pk: 2, username: 'skipped' }, { pk: 77, username: 'skipped_fan' }] };
  return { users: [{ pk: 88, username: 'gone_lookalike' }] };
};
list = [{ id: '1', username: 'kept', full_name: '' }];
list.expectedCount = 2;
let stats = await stub.reconcileWithPrevious('9', 'followers', list, [
  { id: '1', username: 'kept' }, { id: '2', username: 'skipped' }, { id: '3', username: 'gone' },
]);
const names = list.map((u) => u.username).sort().join(',');
check('skipped account is put back, real unfollow is not', names === 'kept,skipped', names);
check('only missing accounts are looked up', calls.length === 2 && calls.every((c) => c.includes('query=')), calls.join(' | '));
check('verify stats', stats.restored === 1 && stats.removed === 1 && stats.unverified === 0, JSON.stringify(stats));

// renamed account (same id) is found by id
calls = [];
stub._responder = () => ({ users: [{ pk: 5, username: 'new_name' }] });
list = [];
stats = await stub.reconcileWithPrevious('9', 'following', list, [{ id: '5', username: 'old_name' }]);
check('renamed account matched by id, stored with new name', list.length === 1 && list[0].username === 'new_name', JSON.stringify(list));

// a failed lookup keeps the account instead of reporting an unfollow
calls = [];
stub._responder = () => { throw new Error('NOT_LOGGED_IN'); };
list = [];
stats = await stub.reconcileWithPrevious('9', 'followers', list, [{ id: '1', username: 'a' }, { id: '2', username: 'b' }]);
check('failed lookup carries account over', list.length === 2 && stats.unverified === 2, JSON.stringify(stats));
check('auth failure stops further lookups', calls.length === 1, `${calls.length} calls`);

// a truncated scan is not checked one by one: everyone kept, still incomplete
calls = [];
list = [{ id: '1', username: 'a' }];
list.isComplete = false;
list.expectedCount = 500;
stats = await stub.reconcileWithPrevious('9', 'followers', list,
  Array.from({ length: 300 }, (_, i) => ({ id: String(i + 2), username: `p${i}` })));
check('truncated scan makes no lookups', calls.length === 0, `${calls.length} calls`);
check('truncated scan keeps everyone, stays incomplete', list.length === 301 && list.isComplete === false,
      `${list.length} ${list.isComplete}`);

// ---- getAppId & getUserInfo tests ----
console.log('\ngetAppId & getUserInfo (from content.js):');
const userSrc = slice(content, '  // Extract the real x-ig-app-id', '  // Sleep helper');
const userCtx = {
  console,
  document: {
    querySelectorAll: () => [],
    querySelector: () => null,
  },
  window: {},
  encodeURIComponent,
  parseInt,
  String,
  Error,
  Array,
  getCSRFToken: () => 'fake_csrf',
  DOMParser: class {
    parseFromString() {
      return {
        querySelectorAll: () => [],
        querySelector: () => null,
      };
    }
  },
  fetch: async (url, opts) => userCtx._responder(url, opts),
};
vm.createContext(userCtx);
vm.runInContext(userSrc + '\n;globalThis.getAppId=getAppId;globalThis.getUserInfo=getUserInfo;', userCtx);

// Test 1: App ID fallback
check('getAppId falls back to 936619743392459', userCtx.getAppId() === '936619743392459', userCtx.getAppId());

// Helper for mocked successful JSON responses
const okJson = (data) => ({
  ok: true,
  status: 200,
  json: async () => data,
  text: async () => JSON.stringify(data),
});
const failStatus = (status, body = '') => ({
  ok: false,
  status,
  json: async () => { throw new Error('Not JSON'); },
  text: async () => body,
});

// Test 2: getUserInfo succeeds via web_profile_info
userCtx._responder = async (url) => {
  if (url.includes('web_profile_info')) {
    return okJson({ data: { user: { id: '123', username: 'testuser', follower_count: 50, following_count: 20, is_private: false } } });
  }
  return failStatus(404);
};
let userInfo = await userCtx.getUserInfo('testuser');
check('getUserInfo succeeds via web_profile_info', userInfo.id === '123' && userInfo.username === 'testuser');

// Test 3: getUserInfo falls back to feed/user when web_profile_info returns 400
userCtx._responder = async (url) => {
  if (url.includes('web_profile_info')) {
    return failStatus(400, '{"message":"Asset asset://laser.provider/ig_business_category_subvertical has been deleted","status":"fail"}');
  }
  if (url.includes('/feed/user/')) {
    return okJson({ items: [{ user: { pk: '456', username: 'creator', follower_count: 100, following_count: 80, is_private: false } }] });
  }
  return failStatus(404);
};
userInfo = await userCtx.getUserInfo('creator');
check('getUserInfo falls back to feed/user when web_profile_info fails with 400', userInfo.id === '456' && userInfo.username === 'creator');

// Test 4: getUserInfo falls back to users/search when feed/user is empty or fails
userCtx._responder = async (url) => {
  if (url.includes('web_profile_info')) return failStatus(400, 'schema error');
  if (url.includes('/feed/user/')) return okJson({ items: [] });
  if (url.includes('/users/search/')) {
    return okJson({ users: [{ pk: '789', username: 'searcheduser', follower_count: 10, following_count: 5, is_private: true }] });
  }
  return failStatus(404);
};
userInfo = await userCtx.getUserInfo('searcheduser');
check('getUserInfo falls back to users/search', userInfo.id === '789' && userInfo.is_private === true);

// Test 5: auth/rate-limit errors must not be swallowed into USER_NOT_FOUND
let threwAuth = false;
userCtx._responder = async () => failStatus(401);
try {
  await userCtx.getUserInfo('any');
} catch (e) {
  threwAuth = (e.message === 'NOT_LOGGED_IN');
}
check('getUserInfo preserves NOT_LOGGED_IN instead of masking as USER_NOT_FOUND', threwAuth);

let threwRate = false;
userCtx._responder = async () => failStatus(429);
try {
  await userCtx.getUserInfo('any');
} catch (e) {
  threwRate = (e.message === 'RATE_LIMITED');
}
check('getUserInfo preserves RATE_LIMITED instead of masking as USER_NOT_FOUND', threwRate);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

