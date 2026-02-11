/**
 * IG Tracker — Background Service Worker
 * Finds Instagram tab and forwards messages to content script
 */

// Find an open Instagram tab
async function getInstagramTab() {
  const tabs = await chrome.tabs.query({ url: 'https://*.instagram.com/*' });
  if (tabs.length > 0) return tabs[0];

  // Open one if none exists
  const tab = await chrome.tabs.create({
    url: 'https://www.instagram.com/',
    active: false,
  });
  // Wait for it to load
  await new Promise((resolve) => {
    const onUpdate = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdate);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
  await new Promise((r) => setTimeout(r, 3000));
  return tab;
}

// Check if content script is alive on a tab
async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return response?.status === 'ok';
  } catch {
    return false;
  }
}

// Forward a message to the content script on an Instagram tab
async function forwardToContentScript(message) {
  const tab = await getInstagramTab();

  // Check if content script is alive
  let alive = await pingContentScript(tab.id);

  if (!alive) {
    // Reload the tab and wait for content script
    await chrome.tabs.reload(tab.id);
    await new Promise((r) => setTimeout(r, 4000));
    alive = await pingContentScript(tab.id);

    if (!alive) {
      return { success: false, error: 'CONTENT_SCRIPT_NOT_LOADED' };
    }
  }

  // Forward the message
  const response = await chrome.tabs.sendMessage(tab.id, message);
  return response;
}

// Handle messages from dashboard/popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_DATA' || message.type === 'FETCH_USER_INFO') {
    forwardToContentScript(message)
      .then((response) => sendResponse(response))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  return false;
});

console.log('[IG Tracker] Background worker loaded v5');
