# Lumen - AI Coding Agent Instructions

## Project Architecture

This is a **Chrome Extension (Manifest V3)** for extracting LinkedIn connections and sending them to Telegram. The architecture follows strict separation of concerns across 3 isolated JavaScript contexts:

### Component Boundaries

1. **[popup.js](../popup.js)** - UI layer
   - Manages `chrome.storage.local` for Telegram config (`telegramBotToken`, `telegramChatId`)
   - Sends messages to content script via `chrome.tabs.sendMessage()`
   - Receives status updates from background via `chrome.runtime.onMessage`

2. **[content.js](../content.js)** - Scraping engine (1050 lines)
   - **NO NETWORK CALLS** - All external API calls go through background.js
   - Phases: (1) Scroll connections list, (2) Navigate profiles, (3) Extract contact info
   - State machine: saves progress to `chrome.storage.local` before each navigation
   - Auto-resumes after page reload using `init()` function checking for active session

3. **[background.js](../background.js)** - Service worker
   - **ONLY** place making external network calls (Telegram Bot API)
   - Batches messages to stay under 4096 char limit
   - Implements retry logic with exponential backoff

### Critical Data Flow

```
popup.js → content.js (action: START_EXTRACTION)
content.js → background.js (type: SEND_TO_TELEGRAM, connections: [...])
background.js → Telegram API → batches sent
background.js → popup.js (type: STATUS updates)
```

**Message types**: `START_EXTRACTION`, `START_FULL_SCRAPE`, `RESUME_SCRAPE`, `SEND_TO_TELEGRAM`, `SEND_CONTACT_TO_TELEGRAM`, `SCRAPING_COMPLETE`, `SCRAPE_PAUSED`, `ERROR_LOG`

## State Management Pattern

Progress is persisted in `chrome.storage.local` with these keys:
- `lumen_connections` - Array of connection objects
- `lumen_current_index` - Index of current profile being scraped
- `lumen_failed_profiles` - Array of profiles that failed after max retries
- `lumen_timestamp` - Auto-expires after 24 hours

**Critical workflow**: Before navigating to a new profile, [content.js](../content.js#L837) calls `saveProgress()`, then sets `window.location.href`. Script restarts on new page, `init()` detects active session, calls `handleProfilePage()` to continue.

## LinkedIn Scraping Patterns

### Intentional Rate Limiting
- Scroll delay: 2-4 seconds randomized (`CONFIG.SCROLL_DELAY_MIN/MAX`)
- Profile visit delay: 60-90 seconds randomized (`CONFIG.PROFILE_DELAY_MIN/MAX`)
- **DO NOT** reduce these delays - they prevent LinkedIn detection

### Selector Strategy with Fallbacks
See [content.js#L38-L85](../content.js#L38-L85) - `SELECTORS` object has multiple fallbacks for each element:
- Connection cards: 3 fallback selectors
- Contact info button: 6 fallback selectors  
- Login/CAPTCHA detection: multiple patterns

When selectors fail, errors are logged via `logError()` with `ERROR_TYPES` enum for categorization.

### Health Check System
[content.js#L141-L233](../content.js#L141-L233) implements session validation:
- `isLoggedOut()` - Detects login page via selectors + URL patterns
- `isCaptchaPresent()` - Detects CAPTCHA/challenges
- `runHealthCheck()` - Called before each scrape operation
- `pauseAndAlert()` - Sends `SCRAPE_PAUSED` message to background, which alerts user via Telegram

## Debugging & Testing

### Console Logging Convention
All logs prefixed with `[Lumen]` - search browser console for this tag.

### Testing Workflows
1. **List extraction only**: Use "Start Extraction" button - faster, no profile visits
2. **Full scrape**: Use "Full Scrape" button - visits each profile (very slow)
3. **Resume**: Stored state allows manual intervention then resume

### Common Issues
- **Selector failures**: Check `SELECTORS` object, add new fallback selectors
- **CAPTCHA triggered**: Too frequent runs - rate limits are intentional
- **Missing contact info**: Modal selectors changed - check `CONTACT_INFO_BUTTON` array

## Configuration & Deployment

### No Build Step Required
Load unpacked extension directly from project root - `manifest.json` is at top level.

### Required Permissions in manifest.json
```json
"permissions": ["activeTab", "scripting", "storage"],
"host_permissions": ["https://www.linkedin.com/*"]
```

### Telegram Setup
Users must provide Bot Token from @BotFather and Chat ID. Config saved in `chrome.storage.local`.

## Unique Conventions

1. **Error logging with context**: Use `logError(ERROR_TYPES.X, {...})` - includes URL, timestamp, selector details
2. **Retry with health checks**: Navigation retries check `isLoggedOut()/isCaptchaPresent()` before each attempt
3. **Profile scraping is recursive**: Each profile load restarts the script, continuation detected in `init()`
4. **Message batching logic**: See [background.js#L70-L102](../background.js#L70-L102) - splits at 4000 chars, not connection count

## Extension Points

When adding new scrapers (jobs, messages, etc.):
- Add new message type constant in all 3 files
- Use the same health check + retry pattern from `handleProfilePage()`
- Follow the state persistence pattern: save before navigate, resume after load
- Never make network calls from content.js - always via background.js
