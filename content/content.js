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

  // Get app ID from page meta or use default
  function getAppId() {
    const meta = document.querySelector('meta[property="al:ios:app_store_id"]');
    return '936619743'; // Instagram app ID
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
        'x-ig-app-id': getAppId(),
        'x-requested-with': 'XMLHttpRequest',
        'x-asbd-id': '129477',
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
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`
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

  // Fetch followers (paginated)
  async function getFollowers(userId, count, onProgress) {
    const followers = [];
    let after = null;
    let hasNext = true;
    const batchSize = 50;

    while (hasNext) {
      const variables = {
        id: userId,
        include_reel: false,
        fetch_mutual: false,
        first: batchSize,
      };
      if (after) variables.after = after;

      const url = `https://www.instagram.com/graphql/query/?query_hash=c76146de99bb02f6415203be841dd25a&variables=${encodeURIComponent(
        JSON.stringify(variables)
      )}`;

      const data = await igFetch(url);
      const edges =
        data?.data?.user?.edge_followed_by?.edges || [];
      const pageInfo =
        data?.data?.user?.edge_followed_by?.page_info || {};

      for (const edge of edges) {
        followers.push({
          id: edge.node.id,
          username: edge.node.username,
          full_name: edge.node.full_name,
          profile_pic_url: edge.node.profile_pic_url,
        });
      }

      hasNext = pageInfo.has_next_page && edges.length > 0;
      after = pageInfo.end_cursor;

      if (onProgress) {
        onProgress({
          type: 'followers',
          fetched: followers.length,
          total: count,
        });
      }

      // Rate limit: pause between requests
      if (hasNext) {
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
      }
    }

    return followers;
  }

  // Fetch following (paginated)
  async function getFollowing(userId, count, onProgress) {
    const following = [];
    let after = null;
    let hasNext = true;
    const batchSize = 50;

    while (hasNext) {
      const variables = {
        id: userId,
        include_reel: false,
        fetch_mutual: false,
        first: batchSize,
      };
      if (after) variables.after = after;

      const url = `https://www.instagram.com/graphql/query/?query_hash=d04b0a864b4b54837c0d870b0e77e076&variables=${encodeURIComponent(
        JSON.stringify(variables)
      )}`;

      const data = await igFetch(url);
      const edges =
        data?.data?.user?.edge_follow?.edges || [];
      const pageInfo =
        data?.data?.user?.edge_follow?.page_info || {};

      for (const edge of edges) {
        following.push({
          id: edge.node.id,
          username: edge.node.username,
          full_name: edge.node.full_name,
          profile_pic_url: edge.node.profile_pic_url,
        });
      }

      hasNext = pageInfo.has_next_page && edges.length > 0;
      after = pageInfo.end_cursor;

      if (onProgress) {
        onProgress({
          type: 'following',
          fetched: following.length,
          total: count,
        });
      }

      if (hasNext) {
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
      return true; // async
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
      return true; // async
    }

    return false;
  });

  console.log('[IG Tracker] Content script loaded');
})();
