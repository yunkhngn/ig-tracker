/**
 * IG Tracker — Content Script (runs on instagram.com)
 * Dynamically extracts x-ig-app-id from the page to avoid useragent mismatch
 */

(() => {
  function getCSRFToken() {
    const match = document.cookie.match(/csrftoken=([^;]+)/);
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
        const match = text.match(/"X-IG-App-ID":"(\d+)"/);
        if (match) return match[1];

        const match2 = text.match(/instagramWebDesktopFBAppId['":\s]+['"](\d+)['"]/);
        if (match2) return match2[1];

        const match3 = text.match(/APP_ID['":\s]+['"](\d+)['"]/);
        if (match3) return match3[1];
      }
    } catch {}

    // Method 2: Try window.__initialData or similar globals
    try {
      if (window.__initialData?.app_id) return window.__initialData.app_id;
    } catch {}

    // Fallback — this is the commonly known app ID
    return '936619743';
  }

  // Make authenticated IG request — no custom x-ig-app-id if not found
  async function igFetch(url, skipAppId = false) {
    const csrf = getCSRFToken();
    if (!csrf) throw new Error('NOT_LOGGED_IN');

    const headers = {
      'x-csrftoken': csrf,
      'x-requested-with': 'XMLHttpRequest',
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

    return res.json();
  }

  // Resolve username → user info
  async function getUserInfo(username) {
    // Try web_profile_info first
    try {
      const d = await igFetch(`/api/v1/users/web_profile_info/?username=${username}`);
      const u = d?.data?.user;
      if (u) return {
        id: u.id || String(u.pk),
        username: u.username,
        full_name: u.full_name || '',
        profile_pic_url: u.profile_pic_url || '',
        follower_count: u.edge_followed_by?.count ?? u.follower_count ?? 0,
        following_count: u.edge_follow?.count ?? u.following_count ?? 0,
        is_private: !!u.is_private,
      };
    } catch (e) {
      console.warn('[IG Tracker] web_profile_info:', e.message);
    }

    // Fallback: search
    try {
      const d = await igFetch(`/api/v1/web/search/topsearch/?query=${username}&context=blended`);
      const match = d?.users?.find(
        (x) => x.user?.username?.toLowerCase() === username.toLowerCase()
      );
      if (match?.user) {
        const u = match.user;
        return {
          id: String(u.pk || u.pk_id),
          username: u.username,
          full_name: u.full_name || '',
          profile_pic_url: u.profile_pic_url || '',
          follower_count: u.follower_count || 0,
          following_count: u.following_count || 0,
          is_private: !!u.is_private,
        };
      }
    } catch (e) {
      console.warn('[IG Tracker] search:', e.message);
    }

    // Fallback: profile page __a=1
    try {
      const d = await igFetch(`/${username}/?__a=1&__d=dis`);
      const u = d?.graphql?.user || d?.user;
      if (u) return {
        id: u.id || String(u.pk),
        username: u.username,
        full_name: u.full_name || '',
        profile_pic_url: u.profile_pic_url || '',
        follower_count: u.edge_followed_by?.count ?? u.follower_count ?? 0,
        following_count: u.edge_follow?.count ?? u.following_count ?? 0,
        is_private: !!u.is_private,
      };
    } catch (e) {
      console.warn('[IG Tracker] __a=1:', e.message);
    }

    throw new Error('USER_NOT_FOUND');
  }

  // Paginated fetch of followers or following
  async function fetchList(userId, type, total) {
    const list = [];
    let maxId = null;

    while (true) {
      let url = `/api/v1/friendships/${userId}/${type}/?count=50`;
      if (maxId) url += `&max_id=${maxId}`;

      const data = await igFetch(url);

      for (const u of data?.users || []) {
        list.push({
          id: String(u.pk || u.pk_id || u.id),
          username: u.username,
          full_name: u.full_name || '',
          profile_pic_url: u.profile_pic_url || '',
        });
      }

      // Send progress update
      chrome.runtime.sendMessage({
        type: 'FETCH_PROGRESS',
        progress: { type, fetched: list.length, total: total || 0 },
      }).catch(() => {});

      if (!data.next_max_id) break;
      maxId = data.next_max_id;

      // Rate limit — 1.0 - 1.5s between pages
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500));
    }

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
        try {
          console.log('[IG Tracker] Fetching data for:', msg.username);
          const userInfo = await getUserInfo(msg.username);
          console.log('[IG Tracker] User found:', userInfo);

          if (userInfo.is_private) {
            chrome.runtime.sendMessage({ 
              type: 'FETCH_ERROR', 
              error: 'PRIVATE_ACCOUNT', 
              data: userInfo 
            });
            return;
          }

          console.log('[IG Tracker] Fetching followers...');
          const followers = await fetchList(userInfo.id, 'followers', userInfo.follower_count);
          console.log(`[IG Tracker] Got ${followers.length} followers`);

          console.log('[IG Tracker] Fetching following...');
          const following = await fetchList(userInfo.id, 'following', userInfo.following_count);
          console.log(`[IG Tracker] Got ${following.length} following`);

          chrome.runtime.sendMessage({
            type: 'FETCH_SUCCESS',
            data: { userInfo, followers, following },
          });
        } catch (err) {
          console.error('[IG Tracker] Error:', err);
          chrome.runtime.sendMessage({ 
            type: 'FETCH_ERROR', 
            error: err.message 
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

  console.log('[IG Tracker] Content script v6 | AppID:', getAppId());
})();
