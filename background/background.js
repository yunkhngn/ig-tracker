/**
 * IG Tracker — Background Service Worker
 * Uses chrome.scripting.executeScript to run fetches inside Instagram tabs
 * This ensures full cookie/session context
 */

// Find an Instagram tab or create one
async function getInstagramTab() {
  const tabs = await chrome.tabs.query({ url: 'https://*.instagram.com/*' });
  if (tabs.length > 0) {
    return tabs[0];
  }
  // Open Instagram in a new tab
  const tab = await chrome.tabs.create({
    url: 'https://www.instagram.com/',
    active: false,
  });
  // Wait for tab to fully load
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  await new Promise((r) => setTimeout(r, 2000));
  return tab;
}

// Execute a function inside an Instagram tab
async function executeInInstagramTab(func, args) {
  const tab = await getInstagramTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: func,
    args: args || [],
    world: 'MAIN', // Run in the page's main world to access cookies
  });

  if (results && results[0]) {
    if (results[0].error) {
      throw new Error(results[0].error.message || 'Script execution failed');
    }
    return results[0].result;
  }
  throw new Error('No result from script execution');
}

// --- Functions that run INSIDE the Instagram tab ---

// Get user info by username (runs in IG tab context)
async function fetchUserInfoInTab(username) {
  const csrfToken = document.cookie
    .split('; ')
    .find((c) => c.startsWith('csrftoken='))
    ?.split('=')[1];

  if (!csrfToken) {
    return { error: 'NOT_LOGGED_IN' };
  }

  const headers = {
    'x-csrftoken': csrfToken,
    'x-ig-app-id': '936619743',
    'x-requested-with': 'XMLHttpRequest',
  };

  // Method 1: web_profile_info
  try {
    const res = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      { headers, credentials: 'include' }
    );
    if (res.ok) {
      const data = await res.json();
      const user = data?.data?.user;
      if (user) {
        return {
          success: true,
          data: {
            id: user.id || String(user.pk),
            username: user.username,
            full_name: user.full_name || '',
            profile_pic_url: user.profile_pic_url || '',
            follower_count: user.edge_followed_by?.count || user.follower_count || 0,
            following_count: user.edge_follow?.count || user.following_count || 0,
            is_private: user.is_private || false,
          },
        };
      }
    }
  } catch (e) {
    console.warn('[IG Tracker] web_profile_info failed:', e.message);
  }

  // Method 2: search
  try {
    const res = await fetch(
      `https://www.instagram.com/api/v1/web/search/topsearch/?query=${encodeURIComponent(username)}&context=blended`,
      { headers, credentials: 'include' }
    );
    if (res.ok) {
      const data = await res.json();
      const found = data?.users?.find(
        (u) => u.user?.username?.toLowerCase() === username.toLowerCase()
      );
      if (found?.user) {
        const u = found.user;
        return {
          success: true,
          data: {
            id: String(u.pk || u.pk_id),
            username: u.username,
            full_name: u.full_name || '',
            profile_pic_url: u.profile_pic_url || '',
            follower_count: u.follower_count || 0,
            following_count: u.following_count || 0,
            is_private: u.is_private || false,
          },
        };
      }
    }
  } catch (e) {
    console.warn('[IG Tracker] search failed:', e.message);
  }

  return { error: 'USER_NOT_FOUND' };
}

// Fetch one page of followers (runs in IG tab context)
async function fetchFollowersPageInTab(userId, maxId) {
  const csrfToken = document.cookie
    .split('; ')
    .find((c) => c.startsWith('csrftoken='))
    ?.split('=')[1];

  let url = `https://www.instagram.com/api/v1/friendships/${userId}/followers/?count=50`;
  if (maxId) url += `&max_id=${maxId}`;

  try {
    const res = await fetch(url, {
      headers: {
        'x-csrftoken': csrfToken,
        'x-ig-app-id': '936619743',
        'x-requested-with': 'XMLHttpRequest',
      },
      credentials: 'include',
    });

    if (!res.ok) {
      return { error: `HTTP_${res.status}` };
    }

    const data = await res.json();
    const users = (data?.users || []).map((u) => ({
      id: String(u.pk || u.pk_id || u.id),
      username: u.username,
      full_name: u.full_name || '',
      profile_pic_url: u.profile_pic_url || '',
    }));

    return {
      success: true,
      users,
      next_max_id: data.next_max_id || null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// Fetch one page of following (runs in IG tab context)
async function fetchFollowingPageInTab(userId, maxId) {
  const csrfToken = document.cookie
    .split('; ')
    .find((c) => c.startsWith('csrftoken='))
    ?.split('=')[1];

  let url = `https://www.instagram.com/api/v1/friendships/${userId}/following/?count=50`;
  if (maxId) url += `&max_id=${maxId}`;

  try {
    const res = await fetch(url, {
      headers: {
        'x-csrftoken': csrfToken,
        'x-ig-app-id': '936619743',
        'x-requested-with': 'XMLHttpRequest',
      },
      credentials: 'include',
    });

    if (!res.ok) {
      return { error: `HTTP_${res.status}` };
    }

    const data = await res.json();
    const users = (data?.users || []).map((u) => ({
      id: String(u.pk || u.pk_id || u.id),
      username: u.username,
      full_name: u.full_name || '',
      profile_pic_url: u.profile_pic_url || '',
    }));

    return {
      success: true,
      users,
      next_max_id: data.next_max_id || null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// --- Background worker orchestration ---

async function fetchAllFollowers(userId, totalCount, sendProgress) {
  const all = [];
  let maxId = null;

  while (true) {
    const result = await executeInInstagramTab(fetchFollowersPageInTab, [userId, maxId]);

    if (result.error) throw new Error(result.error);

    all.push(...result.users);
    sendProgress({ type: 'followers', fetched: all.length, total: totalCount });

    if (!result.next_max_id) break;
    maxId = result.next_max_id;

    // Rate limit
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
  }

  return all;
}

async function fetchAllFollowing(userId, totalCount, sendProgress) {
  const all = [];
  let maxId = null;

  while (true) {
    const result = await executeInInstagramTab(fetchFollowingPageInTab, [userId, maxId]);

    if (result.error) throw new Error(result.error);

    all.push(...result.users);
    sendProgress({ type: 'following', fetched: all.length, total: totalCount });

    if (!result.next_max_id) break;
    maxId = result.next_max_id;

    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
  }

  return all;
}

// Handle messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_DATA') {
    (async () => {
      try {
        const sendProgress = (progress) => {
          chrome.runtime.sendMessage({ type: 'FETCH_PROGRESS', progress }).catch(() => {});
        };

        // Get user info
        const userResult = await executeInInstagramTab(fetchUserInfoInTab, [message.username]);

        if (userResult.error) {
          sendResponse({ success: false, error: userResult.error });
          return;
        }

        const userInfo = userResult.data;
        console.log('[IG Tracker BG] User:', userInfo);

        if (userInfo.is_private) {
          sendResponse({ success: false, error: 'PRIVATE_ACCOUNT', data: userInfo });
          return;
        }

        const followers = await fetchAllFollowers(userInfo.id, userInfo.follower_count, sendProgress);
        const following = await fetchAllFollowing(userInfo.id, userInfo.following_count, sendProgress);

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
    (async () => {
      try {
        const result = await executeInInstagramTab(fetchUserInfoInTab, [message.username]);
        if (result.error) {
          sendResponse({ success: false, error: result.error });
        } else {
          sendResponse({ success: true, data: result.data });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  return false;
});

console.log('[IG Tracker] Background service worker loaded v4');
