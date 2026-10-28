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
      CHECKPOINT_REQUIRED: 'Instagram yêu cầu xác minh tài khoản (Checkpoint). Hãy mở instagram.com để xác minh.',
      FETCH_INCOMPLETE: 'Dữ liệu lấy về không đầy đủ do Instagram giới hạn. Hãy thử lại sau vài phút.',
      IMPORT_INVALID: 'File không hợp lệ. Hãy chọn file JSON được xuất từ IG Tracker.',
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

  // --- Listen for progress + completion from content script ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'FETCH_PROGRESS' && message.progress) {
      const p = message.progress;
      const pct = p.total > 0 ? Math.round((p.fetched / p.total) * 100) : 0;
      const label = p.type === 'followers' ? 'followers' : 'following';
      if (p.phase === 'verify') {
        showStatus(`Đang xác minh ${label} bị thiếu so với lần trước: ${p.fetched}/${p.total}`);
      } else {
        showStatus(`Đang lấy ${label}: ${p.fetched}/${p.total} (${pct}%)`);
      }
      updateProgress(p.fetched, p.total);
    } else if (message.type === 'FETCH_SUCCESS') {
      const { userInfo, followers, following, meta } = message.data;
      handleFetchSuccess(userInfo, followers, following, meta);
    } else if (message.type === 'FETCH_RATE_LIMIT') {
      showStatus(
        `Instagram giới hạn request — thử lại sau ${message.retryInSeconds}s ` +
        `(lần ${message.attempt}/${message.maxAttempts})`
      );
    } else if (message.type === 'FETCH_ERROR') {
      showError(message.error);
      isFetching = false;
      btnFetch.disabled = false;
      btnFetch.classList.remove('fetching');
      const btnLabel = btnFetch.querySelector('.fetch-btn-label');
      if (btnLabel) btnLabel.textContent = 'Quét dữ liệu';
      hideStatus();
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
    btnFetch.classList.add('fetching');
    const btnLabel = btnFetch.querySelector('.fetch-btn-label');
    if (btnLabel) btnLabel.textContent = 'Đang quét...';
    hideError();
    showStatus('Đang kết nối với Instagram...');

    try {
      // Send the last scan along so anyone missing from the new one can be
      // checked individually instead of being reported as an unfollow.
      const prev = await Storage.getLatestCompleteSnapshot(username);
      const pick = (users) => (users || []).map((u) => ({ id: u.id, username: u.username, full_name: u.full_name || '' }));

      // Trigger the fetch
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_DATA',
        username,
        previous: prev ? { followers: pick(prev.followers), following: pick(prev.following) } : null,
      });

      if (!response || !response.success) {
        showError(response?.error || 'UNKNOWN');
        isFetching = false;
        btnFetch.disabled = false;
        btnFetch.classList.remove('fetching');
        if (btnLabel) btnLabel.textContent = 'Quét dữ liệu';
        return;
      }
      
      // Fetch started successfully, wait for events
    } catch (err) {
      showError(err.message);
      isFetching = false;
      btnFetch.disabled = false;
      btnFetch.classList.remove('fetching');
      if (btnLabel) btnLabel.textContent = 'Quét dữ liệu';
    }
  }

  async function handleFetchSuccess(userInfo, followers, following, meta = null) {
    try {
      // Save snapshot with metadata
      showStatus('Đang lưu dữ liệu...');
      await Storage.saveSnapshot(userInfo.username, followers, following, userInfo, meta);

      // Render everything
      await renderAll(userInfo.username);

      const isComplete = meta?.isFollowersComplete !== false && meta?.isFollowingComplete !== false;
      if (isComplete) {
        showStatus(`Hoàn tất! ${followers.length} followers, ${following.length} following`);
      } else {
        const total = userInfo.follower_count || followers.length;
        showStatus(`Đã lấy ${followers.length}/${total} followers (Instagram tạm dừng). Đã bật chế độ bảo vệ dữ liệu.`);
      }
      setTimeout(hideStatus, 4000);
    } catch (e) {
      showError(e.message);
    } finally {
      isFetching = false;
      btnFetch.disabled = false;
      btnFetch.classList.remove('fetching');
      const btnLabel = btnFetch.querySelector('.fetch-btn-label');
      if (btnLabel) btnLabel.textContent = 'Quét dữ liệu';
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

    // Insights: find last complete snapshot to protect known followers
    const snapshots = await Storage.getSnapshots(username);
    let prevComplete = null;
    if (snapshots.length >= 2) {
      for (let i = snapshots.length - 2; i >= 0; i--) {
        const s = snapshots[i];
        if (s.isFollowersComplete !== false && s.isFollowingComplete !== false) {
          prevComplete = s;
          break;
        }
      }
    }
    renderInsights(snapshot, prevComplete);

    // Tracked users chips
    await renderTrackedUsers();
  }

  // --- Overview ---
  function renderOverview(snapshot, username) {
    const expectedFollowers = snapshot.followerCount || snapshot.followers.length;
    const expectedFollowing = snapshot.followingCount || snapshot.following.length;

    document.getElementById('overviewFollowers').textContent =
      formatNumber(expectedFollowers);
    document.getElementById('overviewFollowing').textContent =
      formatNumber(expectedFollowing);

    const ratio =
      expectedFollowing > 0
        ? (expectedFollowers / expectedFollowing).toFixed(2)
        : '∞';
    document.getElementById('overviewRatio').textContent = ratio;

    document.getElementById('overviewLastSync').textContent =
      getTimeAgo(snapshot.timestamp);

    // Changes from previous snapshot (compare with last complete if possible)
    Storage.getSnapshots(username).then((snapshots) => {
      if (snapshots.length >= 2) {
        let prev = snapshots[snapshots.length - 2];
        for (let i = snapshots.length - 2; i >= 0; i--) {
          if (snapshots[i].isFollowersComplete !== false && snapshots[i].isFollowingComplete !== false) {
            prev = snapshots[i];
            break;
          }
        }
        const diff = Storage.computeDiff(prev, snapshots[snapshots.length - 1]);
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

  // Dual-key matcher for fast, robust user lookups across lists
  function createUserMatcher(users) {
    const ids = new Set();
    const usernames = new Set();
    for (const u of users || []) {
      const id = String(u.id || '').trim();
      const uname = String(u.username || '').trim().toLowerCase();
      if (id && id !== 'undefined' && id !== 'null') ids.add(id);
      if (uname && uname !== 'undefined' && uname !== 'null') usernames.add(uname);
    }
    return {
      has(u) {
        if (!u) return false;
        const id = String(u.id || '').trim();
        if (id && id !== 'undefined' && id !== 'null' && ids.has(id)) return true;
        const uname = String(u.username || '').trim().toLowerCase();
        if (uname && uname !== 'undefined' && uname !== 'null' && usernames.has(uname)) return true;
        return false;
      },
    };
  }

  // --- Insights ---
  function renderInsights(snapshot, previousCompleteSnapshot = null) {
    const followerMatcher = createUserMatcher(snapshot.followers);
    const followingMatcher = createUserMatcher(snapshot.following);

    const prevFollowerMatcher = previousCompleteSnapshot
      ? createUserMatcher(previousCompleteSnapshot.followers)
      : null;

    const isFollowersIncomplete = snapshot.isFollowersComplete === false ||
      (snapshot.followerCount > 15 && snapshot.followers.length < snapshot.followerCount * 0.85);

    // Update incomplete warning banner
    const warningEl = document.getElementById('incompleteWarning');
    const warningText = document.getElementById('incompleteWarningText');
    if (warningEl) {
      if (isFollowersIncomplete) {
        warningEl.classList.remove('hidden');
        if (warningText) {
          warningText.textContent = `Instagram chỉ tải được ${snapshot.followers.length}/${snapshot.followerCount} người theo dõi (bị giới hạn phản hồi). Hệ thống đã bật chế độ bảo vệ để không nhận diện sai bạn bè là đã hủy theo dõi. Hãy thử Quét dữ liệu lại sau ít phút.`;
        }
      } else {
        warningEl.classList.add('hidden');
      }
    }

    // People you follow but don't follow you back
    const notFollowingBack = snapshot.following.filter((f) => {
      // 1. If currently in followers list, they definitely follow back
      if (followerMatcher.has(f)) return false;

      // 2. If current fetch was incomplete, but this user was a confirmed follower in the last complete scan,
      // DO NOT falsely accuse them of unfollowing / not following back!
      if (isFollowersIncomplete && prevFollowerMatcher && prevFollowerMatcher.has(f)) {
        return false;
      }

      return true;
    });

    // People who follow you but you don't follow back
    const notFollowedBack = snapshot.followers.filter(
      (f) => !followingMatcher.has(f)
    );

    const badgeLost = document.getElementById('notFollowingBackBadge');
    if (badgeLost) badgeLost.textContent = notFollowingBack.length;
    const badgeGained = document.getElementById('notFollowedBackBadge');
    if (badgeGained) badgeGained.textContent = notFollowedBack.length;

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
      container.innerHTML = `<div class="empty-state" style="padding:24px">${emptyMsg}</div>`;
      return;
    }

    container.innerHTML = users
      .map(
        (u) => `
      <div class="user-item">
        ${avatarHtml(u)}
        <div class="user-info">
          <div class="user-username">${escapeHtml(u.username)}</div>
          <div class="user-fullname">${escapeHtml(u.full_name || '')}</div>
        </div>
        <a href="${escapeHtml(profileUrl(u.username))}" target="_blank" class="user-link">
          <span>Xem</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H7M17 7V17"/></svg>
        </a>
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
        ${avatarHtml(u)}
        <div class="user-info">
          <div class="user-username">${escapeHtml(u.username)}</div>
          <div class="user-fullname">${escapeHtml(u.full_name || '')}</div>
        </div>
        <a href="${escapeHtml(profileUrl(u.username))}" target="_blank" class="user-link">
          <span>Xem</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H7M17 7V17"/></svg>
        </a>
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
        ${avatarHtml(u, 32)}
        <div class="user-info">
          <div class="user-username" style="font-size:13px">${escapeHtml(u.username)}</div>
        </div>
        <a href="${escapeHtml(profileUrl(u.username))}" target="_blank" class="user-link">
          <span>Xem</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H7M17 7V17"/></svg>
        </a>
      </div>`;
  }

  // --- Reset Dashboard to empty state ---
  function resetDashboard() {
    currentUsername = '';
    usernameInput.value = '';
    document.getElementById('overviewFollowers').textContent = '—';
    document.getElementById('overviewFollowing').textContent = '—';
    document.getElementById('overviewRatio').textContent = '—';
    document.getElementById('overviewLastSync').textContent = '—';
    setChangeEl('overviewFollowersChange', 0);
    setChangeEl('overviewFollowingChange', 0);
    document.getElementById('followersCountBadge').textContent = '0';
    document.getElementById('followingCountBadge').textContent = '0';
    const badgeLost = document.getElementById('notFollowingBackBadge');
    if (badgeLost) badgeLost.textContent = '0';
    const badgeGained = document.getElementById('notFollowedBackBadge');
    if (badgeGained) badgeGained.textContent = '0';
    document.getElementById('notFollowingBack').innerHTML =
      '<div class="empty-state" style="padding:24px">Chưa có dữ liệu</div>';
    document.getElementById('notFollowedBack').innerHTML =
      '<div class="empty-state" style="padding:24px">Chưa có dữ liệu</div>';
    document.getElementById('followersList').innerHTML =
      '<div class="empty-state">Nhấn Quét dữ liệu để lấy danh sách</div>';
    document.getElementById('followingList').innerHTML =
      '<div class="empty-state">Nhấn Quét dữ liệu để lấy danh sách</div>';
    document.getElementById('changesList').innerHTML =
      '<div class="empty-state">Cần ít nhất 2 lần quét dữ liệu để so sánh biến động</div>';
  }

  // --- Confirm Delete Modal ---
  function confirmDeleteModal(username) {
    return new Promise((resolve) => {
      const modalOverlay = document.getElementById('deleteModalOverlay');
      const modalDesc = document.getElementById('deleteModalDesc');
      const cancelBtn = document.getElementById('deleteModalCancel');
      const confirmBtn = document.getElementById('deleteModalConfirm');

      modalDesc.innerHTML = `Bạn có chắc muốn xoá toàn bộ dữ liệu scan của <strong>@${escapeHtml(username)}</strong>? Thao tác này không thể hoàn tác.`;

      modalOverlay.classList.remove('hidden');

      function cleanup(result) {
        modalOverlay.classList.add('hidden');
        cancelBtn.removeEventListener('click', onCancel);
        confirmBtn.removeEventListener('click', onConfirm);
        modalOverlay.removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onKeyDown);
        resolve(result);
      }

      function onCancel() { cleanup(false); }
      function onConfirm() { cleanup(true); }
      function onOverlayClick(e) {
        if (e.target === modalOverlay) cleanup(false);
      }
      function onKeyDown(e) {
        if (e.key === 'Escape') cleanup(false);
      }

      cancelBtn.addEventListener('click', onCancel);
      confirmBtn.addEventListener('click', onConfirm);
      modalOverlay.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKeyDown);

      confirmBtn.focus();
    });
  }

  // --- Tracked Users Chips ---
  async function renderTrackedUsers() {
    const users = await Storage.getTrackedUsers();
    trackedUsersEl.innerHTML = users
      .map(
        (u) => `
      <div class="tracked-chip ${u === currentUsername.toLowerCase() ? 'active' : ''}"
           data-user="${escapeHtml(u)}"
           title="@${escapeHtml(u)}">
        <span class="chip-name">@${escapeHtml(u)}</span>
        <button type="button" class="chip-delete" title="Xoá dữ liệu @${escapeHtml(u)}" aria-label="Xoá @${escapeHtml(u)}">✕</button>
      </div>
    `
      )
      .join('');

    trackedUsersEl.querySelectorAll('.tracked-chip').forEach((chip) => {
      const user = chip.dataset.user;

      // Click on chip selects and loads that user
      chip.addEventListener('click', async (e) => {
        if (e.target.closest('.chip-delete')) return;
        usernameInput.value = user;
        currentUsername = user;
        await renderAll(user);
      });

      // Click on delete button removes user data
      const deleteBtn = chip.querySelector('.chip-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const confirmed = await confirmDeleteModal(user);
          if (!confirmed) return;

          await Storage.deleteUser(user);
          const remainingUsers = await Storage.getTrackedUsers();

          if (user === currentUsername.toLowerCase()) {
            if (remainingUsers.length > 0) {
              currentUsername = remainingUsers[0];
              usernameInput.value = currentUsername;
              await renderAll(currentUsername);
            } else {
              resetDashboard();
            }
          }
          await renderTrackedUsers();
        });
      }
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

  // --- Import ---
  const btnImport = document.getElementById('btnImport');
  const importFile = document.getElementById('importFile');

  btnImport.addEventListener('click', () => {
    if (isFetching) return;
    importFile.click();
  });

  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = ''; // allow picking the same file again
    if (!file) return;

    hideError();
    try {
      const imported = await Storage.importAll(await file.text());
      const target = imported.includes(currentUsername.toLowerCase()) ? currentUsername : imported[0];
      usernameInput.value = target;
      await renderAll(target);
      showStatus(`Đã nhập dữ liệu của ${imported.length} tài khoản`);
      setTimeout(hideStatus, 4000);
    } catch (e) {
      showError(e.message);
    }
  });

  // --- Utilities ---

  // Generate gradient avatar with user's initial
  const AVATAR_GRADIENTS = [
    ['#833ab4', '#fd1d1d'], ['#6366f1', '#a855f7'], ['#06b6d4', '#3b82f6'],
    ['#ec4899', '#f43f5e'], ['#10b981', '#059669'], ['#f59e0b', '#d97706'],
    ['#8b5cf6', '#d946ef'], ['#14b8a6', '#0ea5e9'], ['#f43f5e', '#fb7185'],
    ['#3b82f6', '#8b5cf6'], ['#e11d48', '#f97316'], ['#10b981', '#3b82f6'],
  ];

  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function avatarHtml(user, size = 40) {
    const initial = (user.username || '?')[0].toUpperCase();
    const colors = AVATAR_GRADIENTS[hashCode(user.username) % AVATAR_GRADIENTS.length];
    const fontSize = Math.round(size * 0.44);
    return `<div class="user-avatar" style="width:${size}px;height:${size}px;min-width:${size}px;background:linear-gradient(135deg,${colors[0]},${colors[1]});display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${fontSize}px;color:#fff;border-radius:50%;">${initial}</div>`;
  }

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

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  // Escapes quotes too — these values land in attributes, not just text
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  function profileUrl(username) {
    return `https://instagram.com/${encodeURIComponent(username || '')}`;
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
