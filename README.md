# Who Unfollowed You for Instagram™

A privacy-focused Chrome Extension to track your Instagram followers, following lists, and see who unfollowed you.

> **Disclaimer:** This extension is an independent tool and is not affiliated with, endorsed, or sponsored by Instagram or Meta Platforms, Inc.

## Features

- **Dashboard Overview**: View your total followers, following count, and follow ratio at a glance.
- **Insights**:
  - **Not Following Back**: See users you follow who don't follow you back.
  - **Not Followed Back**: See users who follow you but you don't follow back.
- **Track Changes**: Automatically detect gained and lost followers/following between scans.
- **Local Storage**: All data is stored locally on your device for maximum privacy.
- **Export Data**: Export your tracking history to JSON.
- **Multi-account Support**: Track statistics for multiple Instagram accounts.

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the folder of this project.
5. The **Who Unfollowed You** icon should appear in your toolbar.

## Usage

1. Click on the extension icon and select **Open Dashboard**.
2. Enter the Instagram username you want to track.
3. Click **Fetch Data** to start scanning (ensure you are logged into Instagram in your browser).
   Your own account works even if it is private; other people's private accounts do not.
4. Once completed, you can explore the **Followers**, **Following**, **Insights**, and **Changes** tabs.

## Privacy

This extension works by fetching data directly from your browser session with Instagram.
- **No data is sent to external servers.**
- **No external requests at all** — the Inter typeface is vendored in `fonts/`, so the
  dashboard never calls out to a font CDN.
- All analytics and snapshots are stored locally in your browser (`chrome.storage.local`).

### Permissions

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | Keep snapshot history locally; large accounts exceed the default 10MB quota |
| `tabs` | Find (or open) an `instagram.com` tab to run the fetch from |
| `https://*.instagram.com/*` | Read your follower lists using your existing session |

## Development

No build step — load the folder unpacked. Tests are dependency-free Node scripts:

```sh
node test/storage.test.mjs
node test/fetch-and-escaping.test.mjs
```

## License

This project is open-source and available under the [MIT License](LICENSE).
