# Lumen

A Chrome Extension (Manifest V3) that extracts your LinkedIn connections and sends them to Telegram.

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Save the **Bot Token** (looks like `123456789:ABCdefGHI...`)
4. Start a chat with your bot (search for it by username)
5. Get your **Chat ID**:
   - Send any message to your bot
   - Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Find `"chat":{"id":YOUR_CHAT_ID}` in the response

### 2. Install the Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `lumen` folder containing `manifest.json`
5. The extension icon should appear in your toolbar

### 3. Configure the Extension

1. Click the extension icon in Chrome toolbar
2. Enter your **Telegram Bot Token**
3. Enter your **Chat ID**
4. Click **Save Config**

## Usage

1. Log into LinkedIn
2. Navigate to: `https://www.linkedin.com/mynetwork/invite-connect/connections/`
3. Click the extension popup
4. Click **Start Extraction**
5. Watch the page slowly scroll (this takes time - it's intentional!)
6. Check your Telegram for the connections list

## File Structure

```
lumen/
├── manifest.json    # Extension manifest (MV3)
├── popup.html       # Popup UI
├── popup.js         # Popup logic & config management
├── content.js       # DOM extraction & slow scrolling
├── background.js    # Telegram API communication
└── README.md        # This file
```

## How It Works

1. **Popup** → User clicks "Start" → sends message to content script
2. **Content Script** → Slowly scrolls page, extracts name + URL, deduplicates
3. **Background Worker** → Batches data (<4096 chars), sends to Telegram

---

## Known Risks

| Risk | Mitigation |
|------|------------|
| LinkedIn detecting automation | Slow scrolling with random 2-4s delays |
| Rate limiting by LinkedIn | No aggressive polling, single-page operation |
| Selector changes | Documented selectors, multiple fallbacks |
| Telegram rate limits | 1s delay between message batches |

## What NOT To Do (To Avoid LinkedIn Restrictions)

- ❌ **Don't run frequently** - Use sparingly (once a week max)
- ❌ **Don't navigate between pages** - Only use on Connections page
- ❌ **Don't click on profiles** - Only extract visible data
- ❌ **Don't speed up scrolling** - The delays are intentional
- ❌ **Don't use headless browsers** - This is a normal extension
- ❌ **Don't export while logged out** - Must be authenticated
- ❌ **Don't share aggressively** - Personal use only

## Future Extensions (Not Implemented)

- [ ] Jobs listing extraction
- [ ] Export to CSV/JSON instead of Telegram
- [ ] Support for other platforms (Twitter followers, etc.)
- [ ] Incremental sync (only new connections)
- [ ] Storage of previous exports

## Troubleshooting

**"Failed to connect to page"**
- Refresh the LinkedIn Connections page and try again

**No connections found**
- Make sure you're logged into LinkedIn
- Make sure you're on the exact Connections page URL

**Telegram messages not received**
- Verify your Bot Token is correct
- Verify your Chat ID is correct (it may be negative for groups)
- Make sure you've started a chat with your bot first

**Scrolling stops early**
- Some connections may not have loaded. Try manually scrolling first, then run the extension.

## License

Personal use only. Not for commercial purposes.
