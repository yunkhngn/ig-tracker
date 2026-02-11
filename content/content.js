/**
 * IG Tracker — Content Script
 * Injected on instagram.com to access internal API with session cookies
 */

(() => {
  // Extract CSRF token from cookies
  function getCSRFToken() {
    const cookie = document.cookie
      .split('; ')
      .find((c) => c.startsWith('csrftoken='));
    return cookie ? cookie.split('=')[1] : null;
  }

  // Try to get www-claim from cookie or meta tag
  function getWWWClaim() {
    try {
      return sessionStorage.getItem('www-claim-v2') || '0';
    } catch {
      return '0';
    }
  }

  // Fetch with IG headers — returns response object for better error handling
  async function igFetch(url) {
    const csrfToken = getCSRFToken();
    if (!csrfToken) {
      throw new Error('NOT_LOGGED_IN');
    }

    console.log('[IG Tracker] Fetching:', url);

    const res = await fetch(url, {
      headers: {
        'x-csrftoken': csrfToken,
        'x-ig-app-id': '936619743',
        'x-requested-with': 'XMLHttpRequest',
      },
      credentials: 'include',
    });

    console.log('[IG Tracker] Response status:', res.status, 'for', url);

    if (res.status === 401 || res.status === 403) {
      throw new Error('NOT_LOGGED_IN');
    }
    if (res.status === 429) {
      throw new Error('RATE_LIMITED');
    }
    if (!res.ok) {
      // Try to read error body for debugging
      let body = '';
      try { body = await res.text(); } catch {}
      console.error('[IG Tracker] Error body:', body.substring(0, 500));
      throw new Error(`HTTP_${res.status}`);
    }

    return res.json();
  }

  // Get user info by visiting their profile page and extracting shared_data
  // Fallback: use the search endpoint
  async function getUserId(username) {
    // Method 1: web_profile_info
    try {
      const data = await igFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
      );
      const user = data?.data?.user;
      if (user) {
        return {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          profile_pic_url: user.profile_pic_url,
          follower_count: user.edge_followed_by?.count || 0,
          following_count: user.edge_follow?.count || 0,
          is_private: user.is_private,
        };
      }
    } catch (e) {
      console.warn('[IG Tracker] web_profile_info failed:', e.message, '— trying search fallback');
    }

    // Method 2: search bar API
    try {
      const searchData = await igFetch(
        `https://www.instagram.com/api/v1/web/search/topsearch/?query=${encodeURIComponent(username)}&context=blended`
      );
      const found = searchData?.users?.find(
        (u) => u.user?.username?.toLowerCase() === username.toLowerCase()
      );
      if (found?.user) {
        const u = found.user;
        return {
          id: String(u.pk || u.pk_id),
          username: u.username,
          full_name: u.full_name || '',
          profile_pic_url: u.profile_pic_url || '',
          follower_count: u.follower_count || 0,
          following_count: u.following_count || 0,
          is_private: u.is_private || false,
        };
      }
    } catch (e) {
      console.warn('[IG Tracker] search fallback failed:', e.message);
    }

    // Method 3: profile page scrape — get user ID from __a=1
    try {
      const data = await igFetch(
        `https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`
      );
      const user = data?.graphql?.user || data?.user;
      if (user) {
        return {
          id: user.id || String(user.pk),
          username: user.username,
          full_name: user.full_name || '',
          profile_pic_url: user.profile_pic_url || '',
          follower_count: user.edge_followed_by?.count || user.follower_count || 0,
          following_count: user.edge_follow?.count || user.following_count || 0,
          is_private: user.is_private || false,
        };
      }
    } catch (e) {
      console.warn('[IG Tracker] __a=1 fallback failed:', e.message);
    }

    throw new Error('USER_NOT_FOUND');
  }

  // Fetch followers using /api/v1/friendships/ (paginated)
  async function getFollowers(userId, count, onProgress) {
    const followers = [];
    let maxId = null;
    let hasMore = true;

    while (hasMore) {
      let url = `https://www.instagram.com/api/v1/friendships/${userId}/followers/?count=50`;
      if (maxId) url += `&max_id=${maxId}`;

      const data = await igFetch(url);
      const users = data?.users || [];

      for (const u of users) {
        followers.push({
          id: String(u.pk || u.pk_id || u.id),
          username: u.username,
          full_name: u.full_name || '',
          profile_pic_url: u.profile_pic_url || '',
        });
      }

      hasMore = !!data.next_max_id;
      maxId = data.next_max_id;

      if (onProgress) {
        onProgress({
          type: 'followers',
          fetched: followers.length,
          total: count,
        });
      }

      if (hasMore) {
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
      }
    }

    return followers;
  }

  // Fetch following using /api/v1/friendships/ (paginated)
  async function getFollowing(userId, count, onProgress) {
    const following = [];
    let maxId = null;
    let hasMore = true;

    while (hasMore) {
      let url = `https://www.instagram.com/api/v1/friendships/${userId}/following/?count=50`;
      if (maxId) url += `&max_id=${maxId}`;

      const data = await igFetch(url);
      const users = data?.users || [];

      for (const u of users) {
        following.push({
          id: String(u.pk || u.pk_id || u.id),
          username: u.username,
          full_name: u.full_name || '',
          profile_pic_url: u.profile_pic_url || '',
        });
      }

      hasMore = !!data.next_max_id;
      maxId = data.next_max_id;

      if (onProgress) {
        onProgress({
          type: 'following',
          fetched: following.length,
          total: count,
        });
      }

      if (hasMore) {
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
      }
    }

    return following;
  }

  // Listen for messages from background/dashboard
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ status: 'ok' });
      return true;
    }

    if (message.type === 'FETCH_USER_INFO') {
      getUserId(message.username)
        .then((info) => sendResponse({ success: true, data: info }))
        .catch((err) =>
          sendResponse({ success: false, error: err.message })
        );
      return true;
    }

    if (message.type === 'FETCH_DATA') {
      (async () => {
        try {
          const userInfo = await getUserId(message.username);
          console.log('[IG Tracker] User info:', userInfo);

          if (userInfo.is_private) {
            sendResponse({
              success: false,
              error: 'PRIVATE_ACCOUNT',
              data: userInfo,
            });
            return;
          }

          const progressCb = (progress) => {
            chrome.runtime.sendMessage({
              type: 'FETCH_PROGRESS',
              progress,
            }).catch(() => {});
          };

          const followers = await getFollowers(
            userInfo.id,
            userInfo.follower_count,
            progressCb
          );
          const following = await getFollowing(
            userInfo.id,
            userInfo.following_count,
            progressCb
          );

          sendResponse({
            success: true,
            data: {
              userInfo,
              followers,
              following,
            },
          });
        } catch (err) {
          console.error('[IG Tracker] Fetch error:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    return false;
  });

  console.log('[IG Tracker] Content script loaded v2');
})();
