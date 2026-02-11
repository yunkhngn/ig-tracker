/**
 * IG Tracker — Dashboard Logic
 * Handles tab switching, data fetching, rendering, and diff display
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- DOM Elements ---
  const usernameInput = document.getElementById('usernameInput');
  const btnFetch = document.getElementById('btnFetch');
  const btnExport = document.getElementById('btnExport');
  const trackedUsersEl = document.getElementById('trackedUsers');
  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');
  const progressFill = document.getElementById('progressFill');
  const errorBar = document.getElementById('errorBar');
  const errorText = document.getElementById('errorText');
  const errorClose = document.getElementById('errorClose');

  let currentUsername = '';
  let isFetching = false;

  // --- Tab Navigation ---
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      navItems.forEach((n) => n.classList.remove('active'));
      item.classList.add('active');

      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
      const tab = document.getElementById(`tab-${item.dataset.tab}`);
      if (tab) tab.classList.add('active');
    });
  });

  // --- Error handling ---
  errorClose.addEventListener('click', () => {
    errorBar.classList.add('hidden');
  });

  function showError(msg) {
    const messages = {
      NOT_LOGGED_IN: 'Bạn chưa đăng nhập Instagram. Hãy đăng nhập rồi thử lại.',
      RATE_LIMITED: 'Instagram đang giới hạn request. Hãy chờ vài phút rồi thử lại.',
      USER_NOT_FOUND: 'Không tìm thấy username này.',
      PRIVATE_ACCOUNT: 'Tài khoản này ở chế độ riêng tư.',
      CONTENT_SCRIPT_NOT_LOADED: 'Không kết nối được với Instagram. Hãy mở instagram.com và thử lại.',
    };
    errorText.textContent = messages[msg] || `Lỗi: ${msg}`;
    errorBar.classList.remove('hidden');
  }

  function hideError() {
    errorBar.classList.add('hidden');
  }

  // --- Status / Progress ---
  function showStatus(text) {
    statusText.textContent = text;
    statusBar.classList.remove('hidden');
  }

  function hideStatus() {
    statusBar.classList.add('hidden');
    progressFill.style.width = '0%';
  }

  function updateProgress(fetched, total) {
    if (total > 0) {
      const pct = Math.min((fetched / total) * 100, 100);
      progressFill.style.width = `${pct}%`;
    }
  }

  // --- Listen for progress from background ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'FETCH_PROGRESS' && message.progress) {
      const p = message.progress;
      showStatus(`Đang lấy ${p.type === 'followers' ? 'followers' : 'following'}: ${p.fetched}/${p.total}`);
      updateProgress(p.fetched, p.total);
    }
  });

  // --- Fetch Data ---
  btnFetch.addEventListener('click', fetchData);
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchData();
  });

  async function fetchData() {
    const username = usernameInput.value.trim().replace('@', '');
    if (!username) {
      usernameInput.focus();
      return;
    }
    if (isFetching) return;

    isFetching = true;
    currentUsername = username;
    btnFetch.disabled = true;
    hideError();
    showStatus('Đang kết nối với Instagram...');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_DATA',
        username,
      });

      if (!response || !response.success) {
        showError(response?.error || 'UNKNOWN');
        return;
      }

      const { userInfo, followers, following } = response.data;

      // Save snapshot
      showStatus('Đang lưu dữ liệu...');
      await Storage.saveSnapshot(username, followers, following);

      // Render everything
      await renderAll(username);

      showStatus(`Hoàn tất! ${followers.length} followers, ${following.length} following`);
      setTimeout(hideStatus, 3000);
    } catch (err) {
      showError(err.message);
    } finally {
      isFetching = false;
      btnFetch.disabled = false;
    }
  }

  // --- Render All ---
  async function renderAll(username) {
    const snapshot = await Storage.getLatestSnapshot(username);
    if (!snapshot) return;

    currentUsername = username;

    // Overview
    renderOverview(snapshot, username);

    // Followers list
    renderUserList(
      document.getElementById('followersList'),
      snapshot.followers,
      document.getElementById('followersCountBadge')
    );

    // Following list
    renderUserList(
      document.getElementById('followingList'),
      snapshot.following,
      document.getElementById('followingCountBadge')
    );

    // Changes
    await renderChanges(username);

    // Insights
    renderInsights(snapshot);

    // Tracked users chips
    await renderTrackedUsers();
  }

  // --- Overview ---
  function renderOverview(snapshot, username) {
    document.getElementById('overviewFollowers').textContent =
      formatNumber(snapshot.followerCount);
    document.getElementById('overviewFollowing').textContent =
      formatNumber(snapshot.followingCount);

    const ratio =
      snapshot.followingCount > 0
        ? (snapshot.followerCount / snapshot.followingCount).toFixed(2)
        : '∞';
    document.getElementById('overviewRatio').textContent = ratio;

    document.getElementById('overviewLastSync').textContent =
      getTimeAgo(snapshot.timestamp);

    // Changes from previous snapshot
    Storage.getSnapshots(username).then((snapshots) => {
      if (snapshots.length >= 2) {
        const diff = Storage.computeDiff(
          snapshots[snapshots.length - 2],
          snapshots[snapshots.length - 1]
        );
        if (diff) {
          setChangeEl('overviewFollowersChange', diff.followerChange);
          setChangeEl('overviewFollowingChange', diff.followingChange);
        }
      }
    });
  }

  function setChangeEl(id, change) {
    const el = document.getElementById(id);
    if (change === 0) {
      el.textContent = '';
      el.className = 'stat-change';
      return;
    }
    el.textContent = change > 0 ? `+${change}` : `${change}`;
    el.className = `stat-change ${change > 0 ? 'positive' : 'negative'}`;
  }

  // --- Insights ---
  function renderInsights(snapshot) {
    const followerSet = new Set(snapshot.followers.map((f) => f.username));
    const followingSet = new Set(snapshot.following.map((f) => f.username));

    // People you follow but don't follow you back
    const notFollowingBack = snapshot.following.filter(
      (f) => !followerSet.has(f.username)
    );

    // People who follow you but you don't follow back
    const notFollowedBack = snapshot.followers.filter(
      (f) => !followingSet.has(f.username)
    );

    renderInsightList(
      document.getElementById('notFollowingBack'),
      notFollowingBack,
      'Tất cả đều follow lại bạn 🎉'
    );
    renderInsightList(
      document.getElementById('notFollowedBack'),
      notFollowedBack,
      'Bạn đã follow lại tất cả 🎉'
    );
  }

  function renderInsightList(container, users, emptyMsg) {
    if (users.length === 0) {
      container.innerHTML = `<div class="empty-state" style="padding:20px">${emptyMsg}</div>`;
      return;
    }

    container.innerHTML = users
      .map(
        (u) => `
      <div class="user-item">
        <img class="user-avatar" src="${u.profile_pic_url}" alt="" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><rect fill=%22%2327272a%22 width=%2240%22 height=%2240%22/></svg>'">
        <div class="user-info">
          <div class="user-username">${escapeHtml(u.username)}</div>
          <div class="user-fullname">${escapeHtml(u.full_name || '')}</div>
        </div>
        <a href="https://instagram.com/${u.username}" target="_blank" class="user-link">Xem</a>
      </div>
    `
      )
      .join('');
  }

  // --- User List ---
  function renderUserList(container, users, badgeEl) {
    if (badgeEl) badgeEl.textContent = users.length;

    if (users.length === 0) {
      container.innerHTML = '<div class="empty-state">Không có dữ liệu</div>';
      return;
    }

    container.innerHTML = users
      .map(
        (u) => `
      <div class="user-item" data-username="${escapeHtml(u.username)}" data-fullname="${escapeHtml(u.full_name || '')}">
        <img class="user-avatar" src="${u.profile_pic_url}" alt="" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><rect fill=%22%2327272a%22 width=%2240%22 height=%2240%22/></svg>'">
        <div class="user-info">
          <div class="user-username">${escapeHtml(u.username)}</div>
          <div class="user-fullname">${escapeHtml(u.full_name || '')}</div>
        </div>
        <a href="https://instagram.com/${u.username}" target="_blank" class="user-link">Xem</a>
      </div>
    `
      )
      .join('');
  }

  // --- Search ---
  document.getElementById('searchFollowers').addEventListener('input', (e) => {
    filterList('followersList', e.target.value);
  });
  document.getElementById('searchFollowing').addEventListener('input', (e) => {
    filterList('followingList', e.target.value);
  });

  function filterList(containerId, query) {
    const items = document.querySelectorAll(`#${containerId} .user-item`);
    const q = query.toLowerCase();
    items.forEach((item) => {
      const username = (item.dataset.username || '').toLowerCase();
      const fullname = (item.dataset.fullname || '').toLowerCase();
      item.style.display =
        username.includes(q) || fullname.includes(q) ? '' : 'none';
    });
  }

  // --- Changes ---
  async function renderChanges(username) {
    const container = document.getElementById('changesList');
    const history = await Storage.getChangeHistory(username);

    if (history.length === 0) {
      container.innerHTML =
        '<div class="empty-state">Cần ít nhất 2 lần fetch để so sánh</div>';
      return;
    }

    container.innerHTML = history
      .map((diff) => {
        let sections = '';

        if (diff.newFollowers.length > 0) {
          sections += `
          <div class="change-section">
            <div class="change-section-title gained">+${diff.newFollowers.length} followers mới</div>
            ${diff.newFollowers.map((u) => renderMiniUser(u)).join('')}
          </div>`;
        }
        if (diff.lostFollowers.length > 0) {
          sections += `
          <div class="change-section">
            <div class="change-section-title lost">-${diff.lostFollowers.length} unfollowed</div>
            ${diff.lostFollowers.map((u) => renderMiniUser(u)).join('')}
          </div>`;
        }
        if (diff.newFollowing.length > 0) {
          sections += `
          <div class="change-section">
            <div class="change-section-title gained">+${diff.newFollowing.length} bạn follow mới</div>
            ${diff.newFollowing.map((u) => renderMiniUser(u)).join('')}
          </div>`;
        }
        if (diff.lostFollowing.length > 0) {
          sections += `
          <div class="change-section">
            <div class="change-section-title lost">-${diff.lostFollowing.length} bạn bỏ follow</div>
            ${diff.lostFollowing.map((u) => renderMiniUser(u)).join('')}
          </div>`;
        }

        return `
        <div class="change-group">
          <div class="change-date">${formatDate(diff.timestamp)}</div>
          ${sections}
        </div>`;
      })
      .join('');
  }

  function renderMiniUser(u) {
    return `
      <div class="user-item">
        <img class="user-avatar" src="${u.profile_pic_url}" alt="" loading="lazy" style="width:32px;height:32px" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><rect fill=%22%2327272a%22 width=%2240%22 height=%2240%22/></svg>'">
        <div class="user-info">
          <div class="user-username" style="font-size:13px">${escapeHtml(u.username)}</div>
        </div>
        <a href="https://instagram.com/${u.username}" target="_blank" class="user-link">Xem</a>
      </div>`;
  }

  // --- Tracked Users Chips ---
  async function renderTrackedUsers() {
    const users = await Storage.getTrackedUsers();
    trackedUsersEl.innerHTML = users
      .map(
        (u) => `
      <button class="tracked-chip ${u === currentUsername.toLowerCase() ? 'active' : ''}"
              data-user="${escapeHtml(u)}">
        @${escapeHtml(u)}
      </button>
    `
      )
      .join('');

    trackedUsersEl.querySelectorAll('.tracked-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const user = chip.dataset.user;
        usernameInput.value = user;
        currentUsername = user;
        await renderAll(user);
      });
    });
  }

  // --- Export ---
  btnExport.addEventListener('click', async () => {
    const json = await Storage.exportAll();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ig-tracker-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- Utilities ---
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

    if (mins < 1) return 'Vừa xong';
    if (mins < 60) return `${mins} phút trước`;
    if (hours < 24) return `${hours} giờ trước`;
    return `${days} ngày trước`;
  }

  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Init ---
  async function init() {
    const users = await Storage.getTrackedUsers();
    if (users.length > 0) {
      currentUsername = users[0];
      usernameInput.value = currentUsername;
      await renderAll(currentUsername);
    }
    await renderTrackedUsers();
  }

  init();
});
