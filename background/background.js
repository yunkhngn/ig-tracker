/**
 * IG Tracker — Background Service Worker
 * Makes API calls directly using host_permissions + cookies
 */

// Get CSRF token from Instagram cookies
async function getCSRFToken() {
  const cookie = await chrome.cookies.get({
    url: 'https://www.instagram.com',
    name: 'csrftoken',
  });
  return cookie?.value || null;
}

// Get session ID cookie
async function getSessionId() {
  const cookie = await chrome.cookies.get({
    url: 'https://www.instagram.com',
    name: 'sessionid',
  });
  return cookie?.value || null;
}

// Fetch from Instagram API (background SW has host_permissions → no CORS)
async function igFetch(url) {
  const csrfToken = await getCSRFToken();
  const sessionId = await getSessionId();

  if (!csrfToken || !sessionId) {
    throw new Error('NOT_LOGGED_IN');
  }

  console.log('[IG Tracker BG] Fetching:', url);

  const res = await fetch(url, {
    headers: {
      'x-csrftoken': csrfToken,
      'x-ig-app-id': '936619743',
      'x-requested-with': 'XMLHttpRequest',
      'cookie': `csrftoken=${csrfToken}; sessionid=${sessionId}`,
    },
  });

  console.log('[IG Tracker BG] Status:', res.status);

  if (res.status === 401 || res.status === 403) {
    throw new Error('NOT_LOGGED_IN');
  }
  if (res.status === 429) {
    throw new Error('RATE_LIMITED');
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    console.error('[IG Tracker BG] Error:', res.status, body.substring(0, 300));
    throw new Error(`HTTP_${res.status}`);
  }

  return res.json();
}

// Get user info — tries multiple methods
async function getUserId(username) {
  // Method 1: web_profile_info
  try {
    const data = await igFetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
    );
    const user = data?.data?.user;
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
    console.warn('[IG Tracker BG] web_profile_info failed:', e.message);
  }

  // Method 2: search
  try {
    const data = await igFetch(
      `https://www.instagram.com/api/v1/web/search/topsearch/?query=${encodeURIComponent(username)}&context=blended`
    );
    const found = data?.users?.find(
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
    console.warn('[IG Tracker BG] search failed:', e.message);
  }

  // Method 3: __a=1
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
    console.warn('[IG Tracker BG] __a=1 failed:', e.message);
  }

  throw new Error('USER_NOT_FOUND');
}

// Fetch followers (paginated)
async function getFollowers(userId, count, sendProgress) {
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

    sendProgress({ type: 'followers', fetched: followers.length, total: count });

    if (hasMore) {
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
    }
  }

  return followers;
}

// Fetch following (paginated)
async function getFollowing(userId, count, sendProgress) {
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

    sendProgress({ type: 'following', fetched: following.length, total: count });

    if (hasMore) {
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
    }
  }

  return following;
}

// Handle messages from dashboard/popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_DATA') {
    (async () => {
      try {
        // Progress sender
        const sendProgress = (progress) => {
          chrome.runtime.sendMessage({
            type: 'FETCH_PROGRESS',
            progress,
          }).catch(() => {});
        };

        const userInfo = await getUserId(message.username);
        console.log('[IG Tracker BG] User:', userInfo);

        if (userInfo.is_private) {
          sendResponse({ success: false, error: 'PRIVATE_ACCOUNT', data: userInfo });
          return;
        }

        const followers = await getFollowers(userInfo.id, userInfo.follower_count, sendProgress);
        const following = await getFollowing(userInfo.id, userInfo.following_count, sendProgress);

        sendResponse({
          success: true,
          data: { userInfo, followers, following },
        });
      } catch (err) {
        console.error('[IG Tracker BG] Error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'FETCH_USER_INFO') {
    getUserId(message.username)
      .then((info) => sendResponse({ success: true, data: info }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});

console.log('[IG Tracker] Background service worker loaded v3');
