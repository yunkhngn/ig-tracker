/**
 * IG Tracker — Storage Layer
 * Wraps chrome.storage.local for snapshot management
 */

const Storage = {
  MAX_SNAPSHOTS: 50,

  /**
   * Save a snapshot of followers/following for a username
   */
  async saveSnapshot(username, followers, following) {
    const snapshot = {
      timestamp: Date.now(),
      username: username.toLowerCase(),
      followers, // [{ id, username, full_name, profile_pic_url }]
      following, // [{ id, username, full_name, profile_pic_url }]
      followerCount: followers.length,
      followingCount: following.length,
    };

    const key = `snapshots_${username.toLowerCase()}`;
    const data = await chrome.storage.local.get(key);
    let snapshots = data[key] || [];

    snapshots.push(snapshot);

    // Keep only last MAX_SNAPSHOTS
    if (snapshots.length > this.MAX_SNAPSHOTS) {
      snapshots = snapshots.slice(-this.MAX_SNAPSHOTS);
    }

    await chrome.storage.local.set({ [key]: snapshots });

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

    const oldFollowerIds = new Set(oldSnapshot.followers.map((f) => f.username));
    const newFollowerIds = new Set(newSnapshot.followers.map((f) => f.username));
    const oldFollowingIds = new Set(oldSnapshot.following.map((f) => f.username));
    const newFollowingIds = new Set(newSnapshot.following.map((f) => f.username));

    return {
      timestamp: newSnapshot.timestamp,
      newFollowers: newSnapshot.followers.filter(
        (f) => !oldFollowerIds.has(f.username)
      ),
      lostFollowers: oldSnapshot.followers.filter(
        (f) => !newFollowerIds.has(f.username)
      ),
      newFollowing: newSnapshot.following.filter(
        (f) => !oldFollowingIds.has(f.username)
      ),
      lostFollowing: oldSnapshot.following.filter(
        (f) => !newFollowingIds.has(f.username)
      ),
      followerChange:
        newSnapshot.followerCount - oldSnapshot.followerCount,
      followingChange:
        newSnapshot.followingCount - oldSnapshot.followingCount,
    };
  },

  /**
   * Get change history for a username
   */
  async getChangeHistory(username) {
    const snapshots = await this.getSnapshots(username);
    if (snapshots.length < 2) return [];

    const changes = [];
    for (let i = 1; i < snapshots.length; i++) {
      const diff = this.computeDiff(snapshots[i - 1], snapshots[i]);
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
};
