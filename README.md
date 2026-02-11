# IG Tracker

A powerful Chrome Extension to track your Instagram followers, following lists, and detect unfollowers.

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
5. The **IG Tracker** icon should appear in your toolbar.

## Usage

1. Click on the extension icon and select **Open Dashboard**.
2. Enter the Instagram username you want to track.
3. Click **Fetch Data** to start scanning (ensure you are logged into Instagram in your browser).
4. Once completed, you can explore the **Followers**, **Following**, **Insights**, and **Changes** tabs.

## Privacy

This extension works by fetching data directly from your browser session with Instagram.
- **No data is sent to external servers.**
- All analytics and snapshots are stored locally in your browser (`chrome.storage.local`).

## License

This project is open-source and available under the [MIT License](LICENSE).
