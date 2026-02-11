/**
 * IG Tracker — Background Service Worker
 * Facilitates message passing between dashboard and content script
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
  // Wait for tab to load
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  // Extra wait for content script injection
  await new Promise((r) => setTimeout(r, 2000));
  return tab;
}

// Check if content script is alive in a tab
async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return response?.status === 'ok';
  } catch {
    return false;
  }
}

// Forward messages from dashboard to content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Forward fetch requests to content script on IG tab
  if (message.type === 'FETCH_DATA' || message.type === 'FETCH_USER_INFO') {
    (async () => {
      try {
        const tab = await getInstagramTab();

        // Check content script is alive
        const alive = await pingContentScript(tab.id);
        if (!alive) {
          // Try reloading tab and waiting
          await chrome.tabs.reload(tab.id);
          await new Promise((r) => setTimeout(r, 3000));
          const retry = await pingContentScript(tab.id);
          if (!retry) {
            sendResponse({
              success: false,
              error: 'CONTENT_SCRIPT_NOT_LOADED',
            });
            return;
          }
        }

        const response = await chrome.tabs.sendMessage(tab.id, message);
        sendResponse(response);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // async
  }

  // Forward progress events to all extension pages
  if (message.type === 'FETCH_PROGRESS') {
    chrome.runtime.sendMessage(message).catch(() => {});
    return false;
  }

  return false;
});

// Handle extension icon click
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('dashboard/dashboard.html'),
  });
});

console.log('[IG Tracker] Background service worker loaded');
