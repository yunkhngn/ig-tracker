/**
 * IG Tracker — Content Script (runs on instagram.com)
 * Dynamically extracts x-ig-app-id from the page to avoid useragent mismatch
 */

(() => {
  function getCSRFToken() {
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? match[1] : null;
  }

  // The logged-in account's user id, so we can tell "my private account"
  // (whose lists we CAN read) from someone else's (which we can't).
  function getSelfUserId() {
    const match = document.cookie.match(/ds_user_id=([^;]+)/);
    return match ? match[1] : null;
  }

  // Extract the real x-ig-app-id from Instagram's own page scripts
  function getAppId() {
    // Method 1: check for __d in the page's JS config
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent || '';
        // Look for "X-IG-App-ID" or "instagramWebDesktopFBAppId"
        const match = text.match(/"X-IG-App-ID":"(\d+)"/i);
        if (match) return match[1];

        const match2 = text.match(/instagramWebDesktopFBAppId['":\s]+['"](\d+)['"]/i);
        if (match2) return match2[1];

        const match3 = text.match(/APP_ID['":\s]+['"](\d+)['"]/i);
        if (match3) return match3[1];
      }
    } catch {}

    // Method 2: Try window.__initialData or similar globals
    try {
      if (window.__initialData?.app_id) return String(window.__initialData.app_id);
    } catch {}

    // Fallback — the standard Instagram Web Desktop client App ID (15 digits)
    return '936619743392459';
  }

  // Make authenticated IG request — no custom x-ig-app-id if not found
  async function igFetch(url, skipAppId = false) {
    const csrf = getCSRFToken();
    if (!csrf) throw new Error('NOT_LOGGED_IN');

    const headers = {
      'x-csrftoken': csrf,
      'x-requested-with': 'XMLHttpRequest',
      'x-asbd-id': '129477',
    };

    // Only add app-id if we have a real one (to avoid useragent mismatch)
    if (!skipAppId) {
      const appId = getAppId();
      if (appId) headers['x-ig-app-id'] = appId;
    }

    const res = await fetch(url, {
      headers,
      credentials: 'include',
    });

    if (res.status === 401 || res.status === 403) throw new Error('NOT_LOGGED_IN');
    if (res.status === 429) throw new Error('RATE_LIMITED');

    // If we get useragent mismatch, retry WITHOUT x-ig-app-id
    if (res.status === 400 && !skipAppId) {
      const body = await res.text();
      if (body.includes('useragent mismatch')) {
        console.warn('[IG Tracker] useragent mismatch, retrying without x-ig-app-id');
        return igFetch(url, true);
      }
      console.error(`[IG Tracker] 400 for ${url}:`, body.slice(0, 200));
      throw new Error('HTTP_400');
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[IG Tracker] ${res.status} for ${url}:`, body.slice(0, 200));
      throw new Error(`HTTP_${res.status}`);
    }

    const data = await res.json();
    if (data?.status === 'fail') {
      const msg = String(data.message || '').toLowerCase();
      if (msg.includes('rate') || msg.includes('wait') || msg.includes('feedback')) {
        throw new Error('RATE_LIMITED');
      }
      if (msg.includes('checkpoint')) {
        throw new Error('CHECKPOINT_REQUIRED');
      }
      if (msg.includes('login')) {
        throw new Error('NOT_LOGGED_IN');
      }
      throw new Error(data.message || 'API_FAIL');
    }

    return data;
  }

  function isAuthOrRateLimitError(err) {
    const msg = err?.message || '';
    return msg === 'NOT_LOGGED_IN' || msg === 'RATE_LIMITED' || msg === 'CHECKPOINT_REQUIRED';
  }

  // Extract user info from embedded GraphQL JSON scripts
  function getUserFromDOM(username, doc = document) {
    const target = username.toLowerCase();
    const searchObj = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const u = obj.xig_user_by_username || obj.user;
      if (u?.username?.toLowerCase() === target && (u.pk != null || u.id != null)) {
        return u;
      }
      for (const val of Object.values(obj)) {
        const found = searchObj(val);
        if (found) return found;
      }
      return null;
    };

    try {
      const scripts = doc.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        try {
          const json = JSON.parse(s.textContent || 'null');
          const u = searchObj(json);
          if (u) {
            return {
              id: String(u.pk || u.id),
              username: u.username,
              full_name: u.full_name || '',
              profile_pic_url: u.profile_pic_url || '',
              follower_count: u.edge_followed_by?.count ?? u.follower_count ?? 0,
              following_count: u.edge_follow?.count ?? u.following_count ?? 0,
              is_private: !!u.is_private,
            };
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  // Resolve username → user info
  async function getUserInfo(username) {
    const cleanUsername = username.trim().replace(/^@/, '');

    // Method 0: Check if current tab DOM already has user data
    try {
      const domUser = getUserFromDOM(cleanUsername, document);
      if (domUser) return domUser;
    } catch (e) {
      console.warn('[IG Tracker] DOM user lookup:', e.message);
    }

    // Method 1: Try web_profile_info
    try {
      const d = await igFetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanUsername)}`);
      const u = d?.data?.user;
      if (u) return {
        id: String(u.id || u.pk),
        username: u.username,
        full_name: u.full_name || '',
        profile_pic_url: u.profile_pic_url || '',
        follower_count: u.edge_followed_by?.count ?? u.follower_count ?? 0,
        following_count: u.edge_follow?.count ?? u.following_count ?? 0,
        is_private: !!u.is_private,
      };
    } catch (e) {
      if (isAuthOrRateLimitError(e)) throw e;
      console.warn('[IG Tracker] web_profile_info:', e.message);
    }

    // Method 2: Feed by username fallback (bypasses 400 schema error for business/creator accounts)
    try {
      const d = await igFetch(`/api/v1/feed/user/${encodeURIComponent(cleanUsername)}/username/?count=1`);
      const u = d?.items?.[0]?.user || d?.user;
      if (u && (u.pk || u.id)) {
        return {
          id: String(u.pk || u.id),
          username: u.username || cleanUsername,
          full_name: u.full_name || '',
          profile_pic_url: u.profile_pic_url || '',
          follower_count: u.follower_count || 0,
          following_count: u.following_count || 0,
          is_private: !!u.is_private,
        };
      }
    } catch (e) {
      if (isAuthOrRateLimitError(e)) throw e;
      console.warn('[IG Tracker] feed/user fallback:', e.message);
    }

    // Method 3: Search fallback (/api/v1/users/search/)
    try {
      const d = await igFetch(`/api/v1/users/search/?q=${encodeURIComponent(cleanUsername)}`);
      const list = d?.users || d?.results || [];
      const match = list.find(
        (x) => (x.username || x.user?.username || '').toLowerCase() === cleanUsername.toLowerCase()
      );
      const u = match?.user || match;
      if (u && (u.pk || u.id || u.pk_id)) {
        return {
          id: String(u.pk || u.id || u.pk_id),
          username: u.username || cleanUsername,
          full_name: u.full_name || '',
          profile_pic_url: u.profile_pic_url || '',
          follower_count: u.follower_count || 0,
          following_count: u.following_count || 0,
          is_private: !!u.is_private,
        };
      }
    } catch (e) {
      if (isAuthOrRateLimitError(e)) throw e;
      console.warn('[IG Tracker] users/search fallback:', e.message);
    }

    // Method 4: Fetch profile HTML page directly and extract user data
    try {
      const res = await fetch(`/${encodeURIComponent(cleanUsername)}/`, {
        credentials: 'include',
      });
      if (res.ok) {
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const domUser = getUserFromDOM(cleanUsername, doc);
        if (domUser) return domUser;

        const idMatch = text.match(/"user_id":"(\d+)"/) || text.match(/"owner":\{"id":"(\d+)"/) || text.match(/"profile_id":"(\d+)"/);
        const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        const fMatch = ogDesc.match(/([\d,.]+)\s*Followers/i);
        const flMatch = ogDesc.match(/([\d,.]+)\s*Following/i);
        const followerCount = fMatch ? parseInt(fMatch[1].replace(/[,.]/g, ''), 10) : 0;
        const followingCount = flMatch ? parseInt(flMatch[1].replace(/[,.]/g, ''), 10) : 0;
        const isPrivate = text.includes('This Account is Private') || text.includes('Tài khoản này là tài khoản riêng tư');

        if (idMatch) {
          return {
            id: String(idMatch[1]),
            username: cleanUsername,
            full_name: '',
            profile_pic_url: '',
            follower_count: followerCount,
            following_count: followingCount,
            is_private: isPrivate,
          };
        }
      }
    } catch (e) {
      console.warn('[IG Tracker] profile HTML fallback:', e.message);
    }

    throw new Error('USER_NOT_FOUND');
  }

  // Sleep helper
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fetch one page, retrying with backoff when Instagram rate-limits us.
  // A 429 mid-fetch would otherwise throw away every page already collected.
  const RATE_LIMIT_BACKOFF = [30000, 60000, 120000];

  async function igFetchWithBackoff(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await igFetch(url);
      } catch (err) {
        if (err.message !== 'RATE_LIMITED' || attempt >= RATE_LIMIT_BACKOFF.length) throw err;

        const waitMs = RATE_LIMIT_BACKOFF[attempt];
        console.warn(`[IG Tracker] Rate limited, waiting ${waitMs / 1000}s (attempt ${attempt + 1})`);
        chrome.runtime.sendMessage({
          type: 'FETCH_RATE_LIMIT',
          retryInSeconds: waitMs / 1000,
          attempt: attempt + 1,
          maxAttempts: RATE_LIMIT_BACKOFF.length,
        }).catch(() => {});

        await sleep(waitMs);
      }
    }
  }

  // UUID v4 generator for pagination rank_token
  function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function extractUserId(u) {
    if (!u) return '';
    const val = u.pk_id ?? u.pk ?? u.id;
    if (val == null) return '';
    const s = String(val).trim();
    if (!s || s === 'undefined' || s === 'null') return '';
    return s;
  }

  function extractUsername(u) {
    if (!u || !u.username) return '';
    const s = String(u.username).trim().toLowerCase();
    if (!s || s === 'undefined' || s === 'null') return '';
    return s;
  }

  // Paginated fetch of followers or following
  const MAX_PAGES = 2000; // 50 per page — a hard stop so a repeating cursor can't spin forever

  async function fetchList(userId, type, total) {
    const list = [];
    const seenUserKeys = new Set();
    const seenCursors = new Set();
    const rankToken = generateUuid();
    let maxId = null;
    let consecutiveRetries = 0;
    const MAX_RETRIES = 2;

    for (let page = 0; page < MAX_PAGES; page++) {
      let url = `/api/v1/friendships/${userId}/${type}/?count=50&rank_token=${rankToken}&search_surface=follow_list_page`;
      if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;

      const data = await igFetchWithBackoff(url);

      for (const u of data?.users || []) {
        const id = extractUserId(u);
        const uname = extractUsername(u);
        const userKey = id || uname;
        if (!userKey) continue;

        if (!seenUserKeys.has(userKey)) {
          seenUserKeys.add(userKey);
          list.push({
            id: id || userKey,
            username: u.username || uname,
            full_name: u.full_name || '',
          });
        }
      }

      // Send progress update
      chrome.runtime.sendMessage({
        type: 'FETCH_PROGRESS',
        progress: { type, fetched: list.length, total: total || 0 },
      }).catch(() => {});

      if (!data.next_max_id) break;

      // Guard against a cursor that points back at a page we already read
      const nextCursor = String(data.next_max_id);
      if (seenCursors.has(nextCursor)) {
        console.warn('[IG Tracker] Repeated pagination cursor, stopping early');
        break;
      }
      seenCursors.add(nextCursor);
      maxId = data.next_max_id;

      // Rate limit — 1.0 - 1.5s between pages
      await sleep(1000 + Math.random() * 500);
    }

    if (total && total > 5 && list.length === 0) {
      throw new Error('FETCH_INCOMPLETE');
    }

    const expectedTotal = total || 0;
    const allowedDiscrepancy = Math.max(5, Math.round(expectedTotal * 0.1));
    const isComplete = expectedTotal <= 15 ? true : (list.length >= (expectedTotal - allowedDiscrepancy));

    list.isComplete = isComplete;
    list.fetchedCount = list.length;
    list.expectedCount = expectedTotal;

    return list;
  }

  // Message handler
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ status: 'ok' });
      return true;
    }

    if (msg.type === 'FETCH_DATA') {
      // Return immediately to close the trigger channel
      sendResponse({ success: true, status: 'started' });

      (async () => {
        let privateTarget = false;
        try {
          console.log('[IG Tracker] Fetching data for:', msg.username);
          const userInfo = await getUserInfo(msg.username);
          console.log('[IG Tracker] User found:', userInfo);

          // A private account is only off-limits if it isn't ours. When we
          // can't read ds_user_id we try anyway and let the list fetch decide.
          const selfId = getSelfUserId();
          const isSelf = selfId ? String(selfId) === String(userInfo.id) : null;

          privateTarget = userInfo.is_private;

          if (userInfo.is_private && isSelf === false) {
            chrome.runtime.sendMessage({ 
              type: 'FETCH_ERROR', 
              error: 'PRIVATE_ACCOUNT', 
              data: userInfo 
            });
            return;
          }

          console.log('[IG Tracker] Fetching followers...');
          const followers = await fetchList(userInfo.id, 'followers', userInfo.follower_count);
          console.log(`[IG Tracker] Got ${followers.length} followers (complete: ${followers.isComplete})`);

          console.log('[IG Tracker] Fetching following...');
          const following = await fetchList(userInfo.id, 'following', userInfo.following_count);
          console.log(`[IG Tracker] Got ${following.length} following (complete: ${following.isComplete})`);

          chrome.runtime.sendMessage({
            type: 'FETCH_SUCCESS',
            data: {
              userInfo,
              followers,
              following,
              meta: {
                isFollowersComplete: followers.isComplete,
                isFollowingComplete: following.isComplete,
                followersFetched: followers.length,
                followingFetched: following.length,
              },
            },
          });
        } catch (err) {
          console.error('[IG Tracker] Error:', err);
          // An auth failure against a private profile means "no access to
          // this account", not "you are logged out".
          // igFetch maps 401/403 to NOT_LOGGED_IN
          const blockedByPrivacy = privateTarget && err.message === 'NOT_LOGGED_IN';
          chrome.runtime.sendMessage({ 
            type: 'FETCH_ERROR', 
            error: blockedByPrivacy ? 'PRIVATE_ACCOUNT' : err.message 
          });
        }
      })();
      return false; // Don't keep channel open
    }

    if (msg.type === 'FETCH_USER_INFO') {
      getUserInfo(msg.username)
        .then((info) => sendResponse({ success: true, data: info }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    return false;
  });

  console.log('[IG Tracker] Content script v8 | AppID:', getAppId());
})();
