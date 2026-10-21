/**
 * IG Tracker — Background Service Worker
 * Finds Instagram tab and forwards messages to content script
 */

// All open Instagram tabs, with tabs the user isn't looking at first —
// we never want to reload the page someone is actively using.
async function getInstagramTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://*.instagram.com/*' });
  return tabs.sort((a, b) => Number(a.active) - Number(b.active));
}

// Open a background Instagram tab and wait for it to finish loading
async function openInstagramTab() {
  const tab = await chrome.tabs.create({
    url: 'https://www.instagram.com/',
    active: false,
  });
  await waitForLoad(tab.id);
  await new Promise((r) => setTimeout(r, 3000));
  return tab;
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const onUpdate = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdate);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
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

// Find a tab with a live content script, creating or reloading one if needed.
// Reloading is only ever done to a background tab.
async function getReadyTab() {
  const tabs = await getInstagramTabs();

  for (const tab of tabs) {
    if (await pingContentScript(tab.id)) return tab;
  }

  // Nothing responded. Revive a background tab if we have one...
  const background = tabs.find((t) => !t.active);
  if (background) {
    await chrome.tabs.reload(background.id);
    await new Promise((r) => setTimeout(r, 4000));
    if (await pingContentScript(background.id)) return background;
  }

  // ...otherwise open our own rather than disturbing the active tab.
  const fresh = await openInstagramTab();
  if (await pingContentScript(fresh.id)) return fresh;

  return null;
}

// Forward a message to the content script on an Instagram tab
async function forwardToContentScript(message) {
  const tab = await getReadyTab();
  if (!tab) return { success: false, error: 'CONTENT_SCRIPT_NOT_LOADED' };

  return chrome.tabs.sendMessage(tab.id, message);
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

console.log('[IG Tracker] Background worker loaded v6');
