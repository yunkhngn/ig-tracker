/**
 * IG Tracker — Popup Script
 * Shows last sync info and opens dashboard
 */

document.addEventListener('DOMContentLoaded', async () => {
  const openBtn = document.getElementById('openDashboard');

  // Open dashboard in new tab
  openBtn.addEventListener('click', () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL('dashboard/dashboard.html'),
    });
    window.close();
  });

  // Load last sync stats
  try {
    const data = await chrome.storage.local.get(null);
    // Find most recent lastSync
    let mostRecent = null;
    for (const key of Object.keys(data)) {
      if (key.startsWith('lastSync_')) {
        const sync = data[key];
        if (!mostRecent || sync.timestamp > mostRecent.timestamp) {
          mostRecent = sync;
          mostRecent.username = key.replace('lastSync_', '');
        }
      }
    }

    if (mostRecent) {
      document.getElementById('followerCount').textContent =
        formatNumber(mostRecent.followerCount);
      document.getElementById('followingCount').textContent =
        formatNumber(mostRecent.followingCount);

      const timeAgo = getTimeAgo(mostRecent.timestamp);
      document.getElementById('lastSync').innerHTML =
        `<span>@${mostRecent.username} • Đồng bộ ${timeAgo}</span>`;
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
});

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function getTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  if (hours < 24) return `${hours} giờ trước`;
  return `${days} ngày trước`;
}
