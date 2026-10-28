/**
 * IG Tracker — Storage Layer
 * Wraps chrome.storage.local for snapshot management
 */

function extractUserId(u) {
  if (!u) return '';
  const val = u.pk_id ?? u.pk ?? u.id;
  if (val == null) return '';
  const s = String(val).trim();
  if (!s || s === 'undefined' || s === 'null') return '';
  return s;
}

function extractUsername(u) {
  if (!u || !u.username) return '';
  const s = String(u.username).trim().toLowerCase();
  if (!s || s === 'undefined' || s === 'null') return '';
  return s;
}

/**
 * Strip a user record down to the fields the UI actually uses.
 * profile_pic_url was stored but never rendered (avatars are generated from
 * a username hash), and those CDN URLs dominated the storage footprint.
 */
function slim(u) {
  const id = extractUserId(u);
  const username = extractUsername(u);
  return {
    id: id || username,
    username: u.username || username,
    full_name: u.full_name || '',
  };
}

/**
 * Helper to identify a user record consistently across scans.
 * Uses permanent numeric ID first, falling back to lowercased username.
 */
function getUserKey(u) {
  if (!u) return '';
  return extractUserId(u) || extractUsername(u);
}

/**
 * Creates a dual-key matcher that checks both permanent numeric ID and username.
 * Matches if EITHER the user ID or the username matches.
 */
function createUserMatcher(users) {
  const ids = new Set();
  const usernames = new Set();

  for (const u of users || []) {
    const id = extractUserId(u);
    const uname = extractUsername(u);
    if (id) ids.add(id);
    if (uname) usernames.add(uname);
  }

  return {
    ids,
    usernames,
    has(u) {
      if (!u) return false;
      const id = extractUserId(u);
      if (id && ids.has(id)) return true;
      const uname = extractUsername(u);
      if (uname && usernames.has(uname)) return true;
      return false;
    },
  };
}

/**
 * Determine if a fetched list represents a complete scan.
 * Allows a small natural discrepancy (e.g. 5-10% of accounts that are banned or
 * deactivated but still counted in Instagram's profile header counter).
 */
function isListComplete(list, expectedCount, explicitlyComplete) {
  if (explicitlyComplete === false) return false;
  if (explicitlyComplete === true) return true;
  if (!expectedCount || expectedCount <= 15) return true;
  const allowedGap = Math.max(5, Math.round(expectedCount * 0.1));
  return (list?.length || 0) >= (expectedCount - allowedGap);
}

const Storage = {
  MAX_SNAPSHOTS: 50,

  /**
   * Save a snapshot of followers/following for a username
   */
  async saveSnapshot(username, followers, following, userInfo = null, meta = null) {
    const followerCount = (userInfo?.follower_count != null && userInfo.follower_count > 0)
      ? userInfo.follower_count
      : followers.length;
    const followingCount = (userInfo?.following_count != null && userInfo.following_count > 0)
      ? userInfo.following_count
      : following.length;

    const isFollowersComplete = meta?.isFollowersComplete ??
      isListComplete(followers, followerCount, meta?.isFollowersComplete);
    const isFollowingComplete = meta?.isFollowingComplete ??
      isListComplete(following, followingCount, meta?.isFollowingComplete);

    const snapshot = {
      timestamp: Date.now(),
      username: username.toLowerCase(),
      followers: followers.map(slim),
      following: following.map(slim),
      followerCount,
      followingCount,
      fetchedFollowersCount: followers.length,
      fetchedFollowingCount: following.length,
      isFollowersComplete,
      isFollowingComplete,
    };

    const key = `snapshots_${username.toLowerCase()}`;
    const data = await chrome.storage.local.get(key);
    let snapshots = data[key] || [];

    snapshots.push(snapshot);

    // Keep only last MAX_SNAPSHOTS
    if (snapshots.length > this.MAX_SNAPSHOTS) {
      snapshots = snapshots.slice(-this.MAX_SNAPSHOTS);
    }

    await this._writeSnapshots(key, snapshots);

    // Update last synced info
    await chrome.storage.local.set({
      [`lastSync_${username.toLowerCase()}`]: {
        timestamp: snapshot.timestamp,
        followerCount: snapshot.followerCount,
        followingCount: snapshot.followingCount,
      },
    });

    return snapshot;
  },

  /**
   * If we're over quota, drop the oldest snapshots until it fits
   * rather than losing the newest scan.
   */
  async _writeSnapshots(key, snapshots) {
    while (true) {
      try {
        await chrome.storage.local.set({ [key]: snapshots });
        return snapshots;
      } catch (err) {
        const isQuotaError = /quota|QUOTA_BYTES/i.test(err?.message || '');
        if (!isQuotaError || snapshots.length <= 1) throw err;
        console.warn(
          `[IG Tracker] Storage full, dropping oldest snapshot (${snapshots.length} kept)`
        );
        snapshots = snapshots.slice(1);
      }
    }
  },

  /**
   * Get all snapshots for a username
   */
  async getSnapshots(username) {
    const key = `snapshots_${username.toLowerCase()}`;
    const data = await chrome.storage.local.get(key);
    return data[key] || [];
  },

  /**
   * Get the latest snapshot for a username
   */
  async getLatestSnapshot(username) {
    const snapshots = await this.getSnapshots(username);
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  },

  /**
   * Get the latest complete snapshot for a username
   */
  async getLatestCompleteSnapshot(username) {
    const snapshots = await this.getSnapshots(username);
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const snap = snapshots[i];
      if (snap.isFollowersComplete !== false && snap.isFollowingComplete !== false) {
        return snap;
      }
    }
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  },

  /**
   * Get last sync info
   */
  async getLastSync(username) {
    const key = `lastSync_${username.toLowerCase()}`;
    const data = await chrome.storage.local.get(key);
    return data[key] || null;
  },

  /**
   * Compute diff between two snapshots
   */
  computeDiff(oldSnapshot, newSnapshot) {
    if (!oldSnapshot || !newSnapshot) return null;

    const oldFollowerMatcher = createUserMatcher(oldSnapshot.followers);
    const newFollowerMatcher = createUserMatcher(newSnapshot.followers);
    const oldFollowingMatcher = createUserMatcher(oldSnapshot.following);
    const newFollowingMatcher = createUserMatcher(newSnapshot.following);

    const oldExpectedFollowers = oldSnapshot.followerCount || oldSnapshot.followers.length;
    const newExpectedFollowers = newSnapshot.followerCount || newSnapshot.followers.length;
    const oldExpectedFollowing = oldSnapshot.followingCount || oldSnapshot.following.length;
    const newExpectedFollowing = newSnapshot.followingCount || newSnapshot.following.length;

    const isOldFollowersComplete = isListComplete(
      oldSnapshot.followers,
      oldExpectedFollowers,
      oldSnapshot.isFollowersComplete
    );
    const isNewFollowersComplete = isListComplete(
      newSnapshot.followers,
      newExpectedFollowers,
      newSnapshot.isFollowersComplete
    );

    const isOldFollowingComplete = isListComplete(
      oldSnapshot.following,
      oldExpectedFollowing,
      oldSnapshot.isFollowingComplete
    );
    const isNewFollowingComplete = isListComplete(
      newSnapshot.following,
      newExpectedFollowing,
      newSnapshot.isFollowingComplete
    );

    // CRITICAL PROTECTION AGAINST FALSE UNFOLLOWS:
    // If newSnapshot's followers list is incomplete, any missing user from oldSnapshot
    // might simply be on the unfetched pages. We MUST NOT report them as lost followers!
    const lostFollowers = isNewFollowersComplete
      ? oldSnapshot.followers.filter((f) => !newFollowerMatcher.has(f))
      : [];

    // CRITICAL PROTECTION AGAINST FALSE NEW FOLLOWERS:
    // If oldSnapshot's followers list was incomplete, any "new" follower in newSnapshot
    // might have already been following. We MUST NOT report them as new followers!
    const newFollowers = isOldFollowersComplete
      ? newSnapshot.followers.filter((f) => !oldFollowerMatcher.has(f))
      : [];

    const lostFollowing = isNewFollowingComplete
      ? oldSnapshot.following.filter((f) => !newFollowingMatcher.has(f))
      : [];

    const newFollowing = isOldFollowingComplete
      ? newSnapshot.following.filter((f) => !oldFollowingMatcher.has(f))
      : [];

    return {
      timestamp: newSnapshot.timestamp,
      newFollowers,
      lostFollowers,
      newFollowing,
      lostFollowing,
      followerChange: newExpectedFollowers - oldExpectedFollowers,
      followingChange: newExpectedFollowing - oldExpectedFollowing,
      isIncomplete: !isNewFollowersComplete || !isNewFollowingComplete,
    };
  },

  /**
   * Get change history for a username
   */
  async getChangeHistory(username) {
    const snapshots = await this.getSnapshots(username);
    if (snapshots.length < 2) return [];

    const changes = [];
    let lastCompleteSnapshot = null;

    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      const isComplete = (snap.isFollowersComplete !== false) && (snap.isFollowingComplete !== false);

      if (i > 0) {
        // Compare against immediate predecessor, OR if predecessor was incomplete,
        // against the last complete snapshot to give accurate deltas.
        const prevSnap = (snapshots[i - 1].isFollowersComplete !== false && snapshots[i - 1].isFollowingComplete !== false)
          ? snapshots[i - 1]
          : (lastCompleteSnapshot || snapshots[i - 1]);

        const diff = this.computeDiff(prevSnap, snap);
        if (
          diff &&
          (diff.newFollowers.length > 0 ||
            diff.lostFollowers.length > 0 ||
            diff.newFollowing.length > 0 ||
            diff.lostFollowing.length > 0)
        ) {
          changes.push(diff);
        }
      }

      if (isComplete) {
        lastCompleteSnapshot = snap;
      }
    }

    return changes.reverse(); // Most recent first
  },

  /**
   * Get list of tracked usernames
   */
  async getTrackedUsers() {
    const data = await chrome.storage.local.get(null);
    const users = new Set();
    for (const key of Object.keys(data)) {
      if (key.startsWith('snapshots_')) {
        users.add(key.replace('snapshots_', ''));
      }
    }
    return Array.from(users);
  },

  /**
   * Delete all data for a username
   */
  async deleteUser(username) {
    const key = username.toLowerCase();
    await chrome.storage.local.remove([
      `snapshots_${key}`,
      `lastSync_${key}`,
    ]);
  },

  /**
   * Export all data as JSON
   */
  async exportAll() {
    const data = await chrome.storage.local.get(null);
    return JSON.stringify(data, null, 2);
  },

  /**
   * Import a file produced by exportAll. Snapshots are merged with what is
   * already stored (deduplicated by timestamp), so importing never deletes data.
   * Returns the usernames that were imported; throws IMPORT_INVALID on bad input.
   */
  async importAll(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('IMPORT_INVALID');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('IMPORT_INVALID');
    }

    const isSnapshot = (s) =>
      s && typeof s === 'object' &&
      Number.isFinite(s.timestamp) &&
      Array.isArray(s.followers) &&
      Array.isArray(s.following);

    const imported = [];
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith('snapshots_') || !Array.isArray(value)) continue;
      const username = key.slice('snapshots_'.length).toLowerCase();
      if (!username) continue;

      const incoming = value.filter(isSnapshot).map((s) => ({
        ...s,
        username,
        followers: s.followers.map(slim),
        following: s.following.map(slim),
      }));
      if (incoming.length === 0) continue;

      const byTime = new Map();
      for (const s of await this.getSnapshots(username)) byTime.set(s.timestamp, s);
      for (const s of incoming) if (!byTime.has(s.timestamp)) byTime.set(s.timestamp, s);

      let snapshots = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
      if (snapshots.length > this.MAX_SNAPSHOTS) {
        snapshots = snapshots.slice(-this.MAX_SNAPSHOTS);
      }
      snapshots = await this._writeSnapshots(`snapshots_${username}`, snapshots);

      const latest = snapshots[snapshots.length - 1];
      await chrome.storage.local.set({
        [`lastSync_${username}`]: {
          timestamp: latest.timestamp,
          followerCount: latest.followerCount,
          followingCount: latest.followingCount,
        },
      });
      imported.push(username);
    }

    if (imported.length === 0) throw new Error('IMPORT_INVALID');
    return imported;
  },
};
