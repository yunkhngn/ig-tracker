import fs from 'fs';
import vm from 'vm';

// --- fake chrome.storage.local with a byte budget ---
function makeChrome(maxBytes = Infinity) {
  const store = {};
  return {
    storage: {
      local: {
        async get(key) {
          if (key === null) return { ...store };
          return key in store ? { [key]: store[key] } : {};
        },
        async set(obj) {
          const next = { ...store, ...obj };
          if (JSON.stringify(next).length > maxBytes) {
            throw new Error('Resource::kQuotaBytes quota exceeded');
          }
          Object.assign(store, obj);
        },
        async remove(keys) {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete store[k];
        },
      },
    },
    _store: store,
  };
}

function loadStorage(chrome) {
  const ctx = { chrome, console, Date };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('lib/storage.js', 'utf8') + '\n;globalThis.Storage=Storage;', ctx);
  return ctx.Storage;
}

const users = (n, tag) => Array.from({ length: n }, (_, i) => ({
  id: String(i), username: `${tag}${i}`, full_name: `Name ${i}`,
  profile_pic_url: 'https://scontent.cdninstagram.com/' + 'x'.repeat(300),
}));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

// 1. profile_pic_url is stripped
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  const snap = await S.saveSnapshot('alice', users(3, 'f'), users(2, 'g'));
  const keys = Object.keys(snap.followers[0]).sort().join(',');
  check('slim keeps only id,username,full_name', keys === 'full_name,id,username', keys);
  check('counts preserved', snap.followerCount === 3 && snap.followingCount === 2);
  const raw = JSON.stringify(chrome._store);
  check('no CDN urls persisted', !raw.includes('cdninstagram'));
}

// 2. storage size win
{
  const fat = JSON.stringify(users(1000, 'f')).length;
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  await S.saveSnapshot('bob', users(1000, 'f'), []);
  const slimBytes = JSON.stringify(chrome._store).length;
  const pct = Math.round((1 - slimBytes / fat) * 100);
  check(`storage shrank materially (${pct}% smaller)`, pct > 60, `only ${pct}%`);
}

// 3. quota pruning drops oldest, keeps newest
{
  const chrome = makeChrome(30000);
  const S = loadStorage(chrome);
  let last;
  for (let i = 0; i < 12; i++) last = await S.saveSnapshot('carol', users(100, `r${i}_`), []);
  const kept = await S.getSnapshots('carol');
  check('pruned to fit quota', kept.length > 0 && kept.length < 12, `kept ${kept.length}`);
  check('newest snapshot survived', kept[kept.length - 1].timestamp === last.timestamp);
  check('kept snapshots are contiguous & newest', kept[0].followers[0].username.startsWith(`r${12 - kept.length}_`),
        kept[0].followers[0].username);
}

// 4. non-quota errors propagate instead of eating data
{
  const chrome = makeChrome();
  chrome.storage.local.set = async () => { throw new Error('Extension context invalidated'); };
  const S = loadStorage(chrome);
  let threw = null;
  try { await S.saveSnapshot('dave', users(5, 'f'), []); } catch (e) { threw = e.message; }
  check('non-quota error surfaces', threw === 'Extension context invalidated', String(threw));
}

// 5. computeDiff still works on slimmed records
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  await S.saveSnapshot('eve', users(5, 'f'), []);
  await new Promise((r) => setTimeout(r, 2));
  await S.saveSnapshot('eve', users(3, 'f').concat([{ id: '9', username: 'newbie', full_name: '' }]), []);
  const hist = await S.getChangeHistory('eve');
  check('diff detects 1 gained', hist[0].newFollowers.length === 1 && hist[0].newFollowers[0].username === 'newbie');
  check('diff detects 2 lost', hist[0].lostFollowers.length === 2, JSON.stringify(hist[0].lostFollowers.map(u=>u.username)));
  check('followerChange correct', hist[0].followerChange === -1, String(hist[0].followerChange));
}

// 6. computeDiff ignores username changes for same ID (not marked as unfollow)
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  const snap1 = {
    timestamp: 1000,
    username: 'testuser',
    followers: [{ id: '101', username: 'old_handle', full_name: 'Bob' }],
    following: [{ id: '202', username: 'friend_old', full_name: 'Alice' }],
    followerCount: 1,
    followingCount: 1,
  };
  const snap2 = {
    timestamp: 2000,
    username: 'testuser',
    followers: [{ id: '101', username: 'new_handle', full_name: 'Bob' }],
    following: [{ id: '202', username: 'friend_new', full_name: 'Alice' }],
    followerCount: 1,
    followingCount: 1,
  };
  const diff = S.computeDiff(snap1, snap2);
  check('renamed follower not marked as lost', diff.lostFollowers.length === 0);
  check('renamed follower not marked as gained', diff.newFollowers.length === 0);
  check('renamed following not marked as lost', diff.lostFollowing.length === 0);
  check('renamed following not marked as gained', diff.newFollowing.length === 0);
}

// 7. computeDiff is case-insensitive for username when ID is missing
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  const snap1 = {
    timestamp: 1000,
    username: 'testuser',
    followers: [{ id: '', username: 'UserABC', full_name: '' }],
    following: [{ id: '', username: 'FriendXYZ', full_name: '' }],
    followerCount: 1,
    followingCount: 1,
  };
  const snap2 = {
    timestamp: 2000,
    username: 'testuser',
    followers: [{ id: '', username: 'userabc', full_name: '' }],
    following: [{ id: '', username: 'friendxyz', full_name: '' }],
    followerCount: 1,
    followingCount: 1,
  };
  const diff = S.computeDiff(snap1, snap2);
  check('cased follower not marked as lost', diff.lostFollowers.length === 0);
  check('cased following not marked as lost', diff.lostFollowing.length === 0);
}

// 8. deleteUser removes snapshot and lastSync data
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  await S.saveSnapshot('user_to_delete', users(2, 'd'), []);
  await S.saveSnapshot('user_to_keep', users(2, 'k'), []);
  let tracked = await S.getTrackedUsers();
  check('both users tracked initially', tracked.includes('user_to_delete') && tracked.includes('user_to_keep'));
  await S.deleteUser('user_to_delete');
  tracked = await S.getTrackedUsers();
  check('deleted user removed from tracked users', !tracked.includes('user_to_delete') && tracked.includes('user_to_keep'));
  const snap = await S.getSnapshots('user_to_delete');
  check('deleted user snapshots are gone', snap.length === 0);
  const sync = await S.getLastSync('user_to_delete');
  check('deleted user lastSync is gone', sync === null);
}

// 9. Incomplete fetch protection: suppresses false lost followers when new snapshot is partial
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  // Full snapshot with 200 followers
  const snapFull = {
    timestamp: 1000,
    username: 'influencer',
    followers: users(200, 'fan_'),
    following: users(50, 'following_'),
    followerCount: 200,
    followingCount: 50,
    isFollowersComplete: true,
    isFollowingComplete: true,
  };
  // Partial snapshot that cut off at 80 followers, but profile count is still 200
  const snapPartial = {
    timestamp: 2000,
    username: 'influencer',
    followers: users(80, 'fan_'),
    following: users(50, 'following_'),
    followerCount: 200,
    followingCount: 50,
    isFollowersComplete: false,
    isFollowingComplete: true,
  };
  const diff = S.computeDiff(snapFull, snapPartial);
  check('incomplete new scan does NOT falsely accuse 120 missing followers of unfollowing',
        diff.lostFollowers.length === 0, `reported ${diff.lostFollowers.length} lost`);
  check('diff flags isIncomplete', diff.isIncomplete === true);
}

// 10. Incomplete fetch recovery: suppresses false new followers when previous snapshot was partial
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  const snapPartial = {
    timestamp: 1000,
    username: 'influencer',
    followers: users(80, 'fan_'),
    following: users(50, 'following_'),
    followerCount: 200,
    followingCount: 50,
    isFollowersComplete: false,
    isFollowingComplete: true,
  };
  const snapFull = {
    timestamp: 2000,
    username: 'influencer',
    followers: users(200, 'fan_'),
    following: users(50, 'following_'),
    followerCount: 200,
    followingCount: 50,
    isFollowersComplete: true,
    isFollowingComplete: true,
  };
  const diff = S.computeDiff(snapPartial, snapFull);
  check('incomplete old scan does NOT falsely report 120 previously unfetched followers as new',
        diff.newFollowers.length === 0, `reported ${diff.newFollowers.length} new`);
}

// 11. Dual-key matching: matches if EITHER ID or username matches
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  const snap1 = {
    timestamp: 1000,
    username: 'target',
    followers: [
      { id: '101', username: 'alice', full_name: 'Alice' },
      { id: '102', username: 'bob', full_name: 'Bob' },
    ],
    following: [],
    followerCount: 2,
    followingCount: 0,
    isFollowersComplete: true,
    isFollowingComplete: true,
  };
  // Alice has missing ID in snap2, Bob changed username in snap2
  const snap2 = {
    timestamp: 2000,
    username: 'target',
    followers: [
      { id: '', username: 'alice', full_name: 'Alice' },
      { id: '102', username: 'bob_renamed', full_name: 'Bob' },
    ],
    following: [],
    followerCount: 2,
    followingCount: 0,
    isFollowersComplete: true,
    isFollowingComplete: true,
  };
  const diff = S.computeDiff(snap1, snap2);
  check('dual-key matches alice by username when ID is empty', !diff.lostFollowers.some(u => u.username === 'alice'));
  check('dual-key matches bob by ID when username was renamed', !diff.lostFollowers.some(u => u.id === '102'));
  check('no false lost followers under dual-key matching', diff.lostFollowers.length === 0, JSON.stringify(diff.lostFollowers));
  check('no false new followers under dual-key matching', diff.newFollowers.length === 0, JSON.stringify(diff.newFollowers));
}

// 12. Safe ID extraction: undefined/null/missing never collide into "undefined" or "null"
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  const snap = await S.saveSnapshot('test_safe_id', [
    { username: 'user_no_id_1' },
    { pk: null, username: 'user_no_id_2' },
  ], []);
  check('user 1 id is username, not "undefined"', snap.followers[0].id === 'user_no_id_1', snap.followers[0].id);
  check('user 2 id is username, not "null"', snap.followers[1].id === 'user_no_id_2', snap.followers[1].id);
  check('distinct ids generated without collision', snap.followers[0].id !== snap.followers[1].id);
}

// 13. saveSnapshot stores real follower_count from userInfo and flags completeness
{
  const chrome = makeChrome();
  const S = loadStorage(chrome);
  const snap = await S.saveSnapshot('test_user_info', users(50, 'f'), [], {
    follower_count: 200,
    following_count: 30,
  }, {
    isFollowersComplete: false,
    isFollowingComplete: true,
  });
  check('preserves real profile follower_count 200', snap.followerCount === 200, snap.followerCount);
  check('records fetchedFollowersCount as 50', snap.fetchedFollowersCount === 50, snap.fetchedFollowersCount);
  check('preserves isFollowersComplete false flag', snap.isFollowersComplete === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

