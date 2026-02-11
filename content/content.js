/**
 * IG Tracker — Content Script (runs on instagram.com)
 * Has native access to IG cookies via credentials: 'include'
 */

(() => {
  function getCSRFToken() {
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? match[1] : null;
  }

  // Make authenticated IG request
  async function igFetch(url) {
    const csrf = getCSRFToken();
    if (!csrf) throw new Error('NOT_LOGGED_IN');

    const res = await fetch(url, {
      headers: {
        'x-csrftoken': csrf,
        'x-ig-app-id': '936619743',
        'x-requested-with': 'XMLHttpRequest',
      },
      credentials: 'include',
    });

    if (res.status === 401 || res.status === 403) throw new Error('NOT_LOGGED_IN');
    if (res.status === 429) throw new Error('RATE_LIMITED');

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
      const d = await igFetch(
        `/api/v1/users/web_profile_info/?username=${username}`
      );
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
      const d = await igFetch(
        `/api/v1/web/search/topsearch/?query=${username}&context=blended`
      );
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

    throw new Error('USER_NOT_FOUND');
  }

  // Paginated fetch of followers or following
  async function fetchList(userId, type) {
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

      if (!data.next_max_id) break;
      maxId = data.next_max_id;

      // Rate limit — 2-3.5s between pages
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
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
      (async () => {
        try {
          console.log('[IG Tracker] Fetching data for:', msg.username);
          const userInfo = await getUserInfo(msg.username);
          console.log('[IG Tracker] User found:', userInfo);

          if (userInfo.is_private) {
            sendResponse({ success: false, error: 'PRIVATE_ACCOUNT', data: userInfo });
            return;
          }

          console.log('[IG Tracker] Fetching followers...');
          const followers = await fetchList(userInfo.id, 'followers');
          console.log(`[IG Tracker] Got ${followers.length} followers`);

          console.log('[IG Tracker] Fetching following...');
          const following = await fetchList(userInfo.id, 'following');
          console.log(`[IG Tracker] Got ${following.length} following`);

          sendResponse({
            success: true,
            data: { userInfo, followers, following },
          });
        } catch (err) {
          console.error('[IG Tracker] Error:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (msg.type === 'FETCH_USER_INFO') {
      getUserInfo(msg.username)
        .then((info) => sendResponse({ success: true, data: info }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    return false;
  });

  console.log('[IG Tracker] Content script loaded v5');
})();
