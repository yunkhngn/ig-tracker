/**
 * IG Tracker — Content Script
 * Injected on instagram.com to access internal API with session cookies
 * Uses /api/v1/friendships/ REST endpoints
 */

(() => {
  // Extract CSRF token from cookies
  function getCSRFToken() {
    const cookie = document.cookie
      .split('; ')
      .find((c) => c.startsWith('csrftoken='));
    return cookie ? cookie.split('=')[1] : null;
  }

  // Fetch with IG headers
  async function igFetch(url) {
    const csrfToken = getCSRFToken();
    if (!csrfToken) {
      throw new Error('NOT_LOGGED_IN');
    }

    const res = await fetch(url, {
      headers: {
        'x-csrftoken': csrfToken,
        'x-ig-app-id': '936619743',
        'x-requested-with': 'XMLHttpRequest',
        'x-asbd-id': '129477',
        'x-ig-www-claim': sessionStorage.getItem('www-claim-v2') || '0',
      },
      credentials: 'include',
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error('NOT_LOGGED_IN');
    }
    if (res.status === 429) {
      throw new Error('RATE_LIMITED');
    }
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`);
    }

    return res.json();
  }

  // Get user ID from username
  async function getUserId(username) {
    const data = await igFetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
    );
    const user = data?.data?.user;
    if (!user) throw new Error('USER_NOT_FOUND');
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
          id: u.pk || u.pk_id || u.id,
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

      // Rate limit: pause between requests
      if (hasMore) {
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
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
          id: u.pk || u.pk_id || u.id,
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
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
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

          if (userInfo.is_private) {
            sendResponse({
              success: false,
              error: 'PRIVATE_ACCOUNT',
              data: userInfo,
            });
            return;
          }

          // Send progress via runtime messages
          const progressCb = (progress) => {
            chrome.runtime.sendMessage({
              type: 'FETCH_PROGRESS',
              progress,
            });
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
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    return false;
  });

  console.log('[IG Tracker] Content script loaded');
})();
