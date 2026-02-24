# HTML5 Video Playback Speed Control
A Chromium extension that adds a speed control button to the top-right of **ALL** HTML5 videos to adjust the playback speed.

## Features
- A button appears in the format `[-] [speed] [+]` on the top-right corner of every HTML5 video
- Clicking the [-] or [+] buttons decreases or increases the speed by what you set it to in the config popup (default is changing it by increments of 0.05)
    - You can also scroll the mouse wheel down or up respectively
    - You can also press the `[` or `]` keys (configurable in the config popup!)
- The config popup can be accessed by simply left clicking the extension icon in the toolbar
- The config popup will automatically disappear after a few seconds of inactivity, or 10 seconds if your mouse is over the button

## Installation
1. Download and extract this repo somewhere
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" using the toggle in the top-right corner
4. Click "Load unpacked" and select the folder where you extracted the repo
5. The extension should now be installed and active on all HTML5 videos!