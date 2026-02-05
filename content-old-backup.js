/**
 * content.js - LinkedIn Connections & Contact Scraper
 * 
 * Phase 1: Scroll and collect connections list (name + profile URL)
 * Phase 2: Visit each profile, extract contact info (email, phone)
 * Phase 3: Core reliability - detection, retries, error handling
 * 
 * IMPORTANT: This script does NOT make any network calls directly.
 * All external API calls go through background.js
 */

// ============================================
// Prevent Multiple Script Instances
// ============================================

if (window.lumenScriptLoaded) {
  console.log('[Lumen] Script already loaded, skipping duplicate instance');
  throw new Error('Lumen script already loaded');
}
window.lumenScriptLoaded = true;
console.log('[Lumen] Script instance initialized');

// ============================================
// Configuration
// ============================================

const CONFIG = {
  // Scroll settings
  SCROLL_STEP: 800,
  SCROLL_DELAY_MIN: 2000,
  SCROLL_DELAY_MAX: 4000,
  MAX_SCROLL_ATTEMPTS: 200,
  EXTRACTION_DELAY: 500,
  
  // Profile scraping settings (adaptive)
  PROFILE_DELAY_MIN: 60000,
  PROFILE_DELAY_MAX: 90000,
  PROFILE_DELAY_INCREASE_FACTOR: 1.3,
  PROFILE_DELAY_DECREASE_FACTOR: 0.9,
  PAGE_LOAD_WAIT: 5000,
  CONTACT_MODAL_WAIT: 2000,
  
  // Reliability settings
  MAX_RETRIES: 3,
  RETRY_DELAY: 5000,
  PAGE_LOAD_TIMEOUT: 30000,
  
  // Adaptive thresholds
  SLOW_PAGE_LOAD_THRESHOLD: 8000,
  FAST_PAGE_LOAD_THRESHOLD: 2000,
  CONSECUTIVE_SLOW_LOADS_TRIGGER: 3,
};

// Runtime adaptive settings
let adaptiveDelayMin = CONFIG.PROFILE_DELAY_MIN;
let adaptiveDelayMax = CONFIG.PROFILE_DELAY_MAX;
let consecutiveSlowLoads = 0;
let consecutiveFastLoads = 0;
let pageLoadTimes = [];

// Execution guard to prevent double-running
let isExecuting = false;

// ============================================
// Error Types for Specific Logging
// ============================================

const ERROR_TYPES = {
  LOGGED_OUT: 'LOGGED_OUT',
  CAPTCHA: 'CAPTCHA',
  PAGE_LOAD_FAILED: 'PAGE_LOAD_FAILED',
  SELECTOR_FAILED: 'SELECTOR_FAILED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN: 'UNKNOWN',
};

// ============================================
// LinkedIn DOM Selectors
// ============================================

const SELECTORS = {
  // Connections list
  CONNECTION_CARD: 'li.mn-connection-card',
  CONNECTION_CARD_ALT_1: '[data-view-name="connection-card"]',
  CONNECTION_CARD_ALT_2: '.scaffold-finite-scroll__content > ul > li',
  PROFILE_LINK: 'a[href*="/in/"]',
  LOADING_INDICATOR: '.artdeco-loader',
  SCROLL_CONTAINER: 'main',
  
  // Contact info button selectors
  CONTACT_INFO_BUTTON: [
    'a[href*="/overlay/contact-info"]',
    '#top-card-text-details-contact-info',
    'a[data-control-name="contact_see_more"]',
    '.pv-text-details__separator + a',
    '[data-test-id="contact-info-cta"]',
    'a[href*="contact-info"]',
  ],
  
  // Session detection selectors
  LOGIN_PAGE: [
    'form.login__form',
    '[data-id="sign-in-form"]',
    'input[name="session_key"]',
    '.sign-in-form',
  ],
  
  CAPTCHA_INDICATORS: [
    'iframe[src*="captcha"]',
    'iframe[src*="challenge"]',
    '#captcha',
    '.captcha',
    '[data-captcha]',
    'iframe[title*="challenge"]',
    '#cf-challenge-running',
  ],
  
  // Profile page verification
  PROFILE_PAGE_INDICATORS: [
    '.pv-top-card',
    '[data-test-id="profile-top-card"]',
    '.profile-rail-card',
    'main[class*="profile"]',
    'section.artdeco-card',
  ],
};

// ============================================
// Selector Success Tracking
// ============================================

let selectorStats = {
  connectionCard: {},
  contactButton: {},
  email: {},
  phone: {},
};

async function loadSelectorStats() {
  const data = await chrome.storage.local.get('lumen_selector_stats');
  if (data.lumen_selector_stats) {
    selectorStats = { ...selectorStats, ...data.lumen_selector_stats };
  }
}

async function saveSelectorStats() {
  await chrome.storage.local.set({ lumen_selector_stats: selectorStats });
}

function recordSelectorSuccess(type, selector) {
  if (!selectorStats[type]) selectorStats[type] = {};
  selectorStats[type][selector] = (selectorStats[type][selector] || 0) + 1;
  saveSelectorStats();
}

function getSortedSelectors(type, fallbackArray) {
  if (!selectorStats[type] || Object.keys(selectorStats[type]).length === 0) {
    return fallbackArray;
  }
  
  const sorted = Object.entries(selectorStats[type])
    .sort(([, a], [, b]) => b - a)
    .map(([selector]) => selector);
  
  const remaining = fallbackArray.filter(s => !sorted.includes(s));
  return [...sorted, ...remaining];
}

// ============================================
// Utility Functions
// ============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sendStatus(text, level = '') {
  chrome.runtime.sendMessage({ type: 'STATUS', text, level });
  console.log(`[Lumen] ${text}`);
}

function logError(errorType, details) {
  const errorLog = {
    type: errorType,
    details,
    url: window.location.href,
    timestamp: new Date().toISOString(),
  };
  console.error(`[Lumen] ERROR:`, errorLog);
  
  // Send to background for potential storage/reporting
  chrome.runtime.sendMessage({ 
    type: 'ERROR_LOG', 
    error: errorLog 
  });
}

// ============================================
// Session & Health Detection
// ============================================

/**
 * Check if user is logged out of LinkedIn
 * Returns true if logged out (should pause)
 */
function isLoggedOut() {
  for (const selector of SELECTORS.LOGIN_PAGE) {
    if (document.querySelector(selector)) {
      console.log(`[Lumen] DETECTED: Logged out (matched: ${selector})`);
      return true;
    }
  }
  
  // Check URL patterns
  const url = window.location.href.toLowerCase();
  if (url.includes('/login') || 
      url.includes('/signin') || 
      url.includes('/authwall') ||
      url.includes('/checkpoint')) {
    console.log(`[Lumen] DETECTED: Logged out (URL pattern)`);
    return true;
  }
  
  return false;
}

/**
 * Check if CAPTCHA/challenge is present
 * Returns true if CAPTCHA detected (should pause)
 */
function isCaptchaPresent() {
  for (const selector of SELECTORS.CAPTCHA_INDICATORS) {
    if (document.querySelector(selector)) {
      console.log(`[Lumen] DETECTED: CAPTCHA (matched: ${selector})`);
      return true;
    }
  }
  
  // Check URL patterns
  const url = window.location.href.toLowerCase();
  if (url.includes('/checkpoint/challenge') || 
      url.includes('/security/captcha')) {
    console.log(`[Lumen] DETECTED: CAPTCHA (URL pattern)`);
    return true;
  }
  
  // Check page title
  const title = document.title.toLowerCase();
  if (title.includes('security verification') || 
      title.includes('captcha') ||
      title.includes('checkpoint')) {
    console.log(`[Lumen] DETECTED: CAPTCHA (page title)`);
    return true;
  }
  
  return false;
}

/**
 * Verify profile page loaded correctly
 * Returns true if profile page elements are present
 */
function isProfilePageLoaded() {
  const url = window.location.href;
  const bodyText = document.body?.innerText || '';
  
  console.log('[Lumen] Checking if profile loaded...');
  console.log('[Lumen] URL:', url);
  console.log('[Lumen] Body length:', bodyText.length);
  console.log('[Lumen] Has h1:', !!document.querySelector('h1'));
  
  // Primary check: URL pattern + basic content
  if (url.includes('/in/') && !url.includes('/mynetwork')) {
    console.log('[Lumen] ✓ URL is profile page');
    
    // Just check if page has any substantial content
    if (bodyText.length > 500) {
      console.log(`[Lumen] ✓ Page has content (${bodyText.length} chars)`);
      console.log('[Lumen] ✅ Profile page LOADED');
      return true;
    } else {
      console.log(`[Lumen] ✗ Not enough content yet (${bodyText.length} chars)`);
    }
  } else {
    console.log('[Lumen] ✗ URL not a profile page');
  }
  
  return false;
}

/**
 * Run all health checks
 * Returns { healthy: boolean, error: string | null, errorType: string | null }
 */
function runHealthCheck() {
  if (isLoggedOut()) {
    return {
      healthy: false,
      error: 'LinkedIn session expired. Please log in again.',
      errorType: ERROR_TYPES.LOGGED_OUT,
    };
  }
  
  if (isCaptchaPresent()) {
    return {
      healthy: false,
      error: 'CAPTCHA detected. Please solve it manually, then resume.',
      errorType: ERROR_TYPES.CAPTCHA,
    };
  }
  
  return { healthy: true, error: null, errorType: null };
}

// ============================================
// Pause & Alert Functions
// ============================================

async function pauseAndAlert(errorType, message) {
  logError(errorType, message);
  sendStatus(`⚠️ PAUSED: ${message}`, 'error');
  
  // Notify background to alert user
  chrome.runtime.sendMessage({
    type: 'SCRAPE_PAUSED',
    reason: errorType,
    message: message,
  });
  
  // Save current state so user can resume after fixing
  // (progress is already saved before navigation)
}

// ============================================
// Retry Logic
// ============================================

/**
 * Wait for page to load with health checks
 * Returns { success: boolean, error: string | null }
 */
async function waitForPageLoad(timeout = CONFIG.PAGE_LOAD_TIMEOUT) {
  const startTime = Date.now();
  let attempts = 0;
  
  console.log(`[Lumen] Waiting for page load... (timeout: ${timeout}ms)`);
  
  while (Date.now() - startTime < timeout) {
    attempts++;
    
    // Run health check first
    const health = runHealthCheck();
    if (!health.healthy) {
      console.log(`[Lumen] Health check failed: ${health.error}`);
      return { success: false, error: health.error, errorType: health.errorType };
    }
    
    // Check if profile page loaded
    if (isProfilePageLoaded()) {
      const loadTime = Date.now() - startTime;
      console.log(`[Lumen] Page loaded successfully in ${loadTime}ms (attempt ${attempts})`);
      
      // Track load time and adjust delays adaptively
      adjustAdaptiveDelays(loadTime);
      
      return { success: true, error: null, loadTime };
    }
    
    if (attempts % 5 === 0) {
      console.log(`[Lumen] Still waiting... (attempt ${attempts}, ${Math.round((Date.now() - startTime)/1000)}s elapsed)`);
    }
    
    await sleep(1000);
  }
  
  const loadTime = Date.now() - startTime;
  console.error(`[Lumen] Page load timeout after ${loadTime}ms`);
  adjustAdaptiveDelays(loadTime);
  
  return { 
    success: false, 
    error: 'Page load timeout', 
    errorType: ERROR_TYPES.PAGE_LOAD_FAILED,
    loadTime 
  };
}

function adjustAdaptiveDelays(loadTime) {
  pageLoadTimes.push(loadTime);
  if (pageLoadTimes.length > 10) pageLoadTimes.shift();
  
  if (loadTime > CONFIG.SLOW_PAGE_LOAD_THRESHOLD) {
    consecutiveSlowLoads++;
    consecutiveFastLoads = 0;
    
    if (consecutiveSlowLoads >= CONFIG.CONSECUTIVE_SLOW_LOADS_TRIGGER) {
      // LinkedIn is slow/throttling - increase delays
      adaptiveDelayMin = Math.min(adaptiveDelayMin * CONFIG.PROFILE_DELAY_INCREASE_FACTOR, 180000);
      adaptiveDelayMax = Math.min(adaptiveDelayMax * CONFIG.PROFILE_DELAY_INCREASE_FACTOR, 240000);
      sendStatus(`⚠️ LinkedIn seems busy, increasing delay to ${Math.round(adaptiveDelayMin/1000)}-${Math.round(adaptiveDelayMax/1000)}s`, 'info');
      consecutiveSlowLoads = 0;
    }
  } else if (loadTime < CONFIG.FAST_PAGE_LOAD_THRESHOLD) {
    consecutiveFastLoads++;
    consecutiveSlowLoads = 0;
    
    if (consecutiveFastLoads >= 5) {
      // LinkedIn is fast - can decrease delays slightly
      adaptiveDelayMin = Math.max(adaptiveDelayMin * CONFIG.PROFILE_DELAY_DECREASE_FACTOR, CONFIG.PROFILE_DELAY_MIN);
      adaptiveDelayMax = Math.max(adaptiveDelayMax * CONFIG.PROFILE_DELAY_DECREASE_FACTOR, CONFIG.PROFILE_DELAY_MAX);
      consecutiveFastLoads = 0;
    }
  }
}

/**
 * Navigate to URL with retry logic
 * Returns { success: boolean, error: string | null }
 */
async function navigateWithRetry(url, maxRetries = CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    sendStatus(`Navigating to profile (attempt ${attempt}/${maxRetries})...`, 'info');
    
    window.location.href = url;
    
    // Wait for navigation to complete
    await sleep(CONFIG.PAGE_LOAD_WAIT);
    
    // Check page load
    const loadResult = await waitForPageLoad();
    
    if (loadResult.success) {
      return { success: true, error: null };
    }
    
    // If logged out or CAPTCHA, don't retry
    if (loadResult.errorType === ERROR_TYPES.LOGGED_OUT || 
        loadResult.errorType === ERROR_TYPES.CAPTCHA) {
      return loadResult;
    }
    
    // Retry on page load failure
    if (attempt < maxRetries) {
      sendStatus(`Page load failed, retrying in ${CONFIG.RETRY_DELAY / 1000}s...`, 'info');
      await sleep(CONFIG.RETRY_DELAY);
    }
  }
  
  return { 
    success: false, 
    error: `Failed to load page after ${maxRetries} attempts`,
    errorType: ERROR_TYPES.PAGE_LOAD_FAILED,
  };
}

// ============================================
// State Management
// ============================================

async function saveProgress(connections, currentIndex, failedProfiles = []) {
  await chrome.storage.local.set({
    lumen_connections: connections,
    lumen_current_index: currentIndex,
    lumen_failed_profiles: failedProfiles,
    lumen_timestamp: Date.now()
  });
}

async function loadProgress() {
  const data = await chrome.storage.local.get([
    'lumen_connections',
    'lumen_current_index',
    'lumen_failed_profiles',
    'lumen_timestamp'
  ]);
  
  if (data.lumen_timestamp && Date.now() - data.lumen_timestamp > 24 * 60 * 60 * 1000) {
    await clearProgress();
    return null;
  }
  
  if (data.lumen_connections && data.lumen_current_index !== undefined) {
    return {
      connections: data.lumen_connections,
      currentIndex: data.lumen_current_index,
      failedProfiles: data.lumen_failed_profiles || [],
    };
  }
  return null;
}

async function clearProgress() {
  await chrome.storage.local.remove([
    'lumen_connections',
    'lumen_current_index',
    'lumen_failed_profiles',
    'lumen_timestamp'
  ]);
}

// ============================================
// DOM Extraction with Error Logging
// ============================================

function extractConnectionsFromDOM() {
  const connections = [];
  const seenUrls = new Set();
  const selectorResults = {};
  
  // Try each selector strategy and log results
  const profileLinks = document.querySelectorAll('a[href*="/in/"]');
  selectorResults['a[href*="/in/"]'] = profileLinks.length;
  
  console.log(`[Lumen] Selector results:`, selectorResults);
  
  if (profileLinks.length === 0) {
    logError(ERROR_TYPES.SELECTOR_FAILED, {
      message: 'No profile links found',
      selectors_tried: Object.keys(selectorResults),
      page_content_preview: document.body?.innerText?.substring(0, 500),
    });
  }
  
  profileLinks.forEach(linkEl => {
    try {
      const isInMainContent = linkEl.closest('main') !== null;
      const isInConnectionsList = linkEl.closest('[class*="connection"]') !== null ||
                                   linkEl.closest('[class*="scaffold-finite-scroll"]') !== null ||
                                   linkEl.closest('ul') !== null;
      
      if (!isInMainContent && !isInConnectionsList) {
        return;
      }
      
      let profileUrl = linkEl.href;
      
      if (seenUrls.has(profileUrl)) {
        return;
      }
      
      if (profileUrl) {
        const url = new URL(profileUrl);
        profileUrl = `${url.origin}${url.pathname}`.replace(/\/$/, '');
      }
      
      if (!profileUrl.includes('/in/')) {
        return;
      }
      
      let name = '';
      let nameStrategy = '';
      
      // Strategy A: aria-hidden span
      const ariaHiddenSpan = linkEl.querySelector('span[aria-hidden="true"]');
      if (ariaHiddenSpan) {
        name = ariaHiddenSpan.textContent.trim();
        nameStrategy = 'aria-hidden-span';
      }
      
      // Strategy B: Parent container span
      if (!name) {
        const container = linkEl.closest('li') || linkEl.closest('[class*="card"]') || linkEl.parentElement;
        if (container) {
          const nameSpan = container.querySelector('span[aria-hidden="true"]');
          if (nameSpan) {
            name = nameSpan.textContent.trim();
            nameStrategy = 'parent-container-span';
          }
        }
      }
      
      // Strategy C: Link text
      if (!name) {
        name = linkEl.textContent.trim().split('\n')[0].trim();
        nameStrategy = 'link-text';
      }
      
      // Strategy D: aria-label
      if (!name) {
        name = linkEl.getAttribute('aria-label') || '';
        nameStrategy = 'aria-label';
      }
      
      name = name.replace(/\s+/g, ' ').trim();
      name = name.replace(/^View\s+/i, '').replace(/['']s profile$/i, '').trim();
      
      if (!name || name.toLowerCase().includes('message') || name.length < 2) {
        return;
      }
      
      seenUrls.add(profileUrl);
      connections.push({ 
        name, 
        profileUrl,
        nameStrategy, // Log which strategy worked
        email: null,
        phone: null,
        scraped: false,
        retryCount: 0,
      });
      
    } catch (err) {
      logError(ERROR_TYPES.UNKNOWN, {
        message: 'Error extracting connection',
        error: err.message,
      });
    }
  });
  
  console.log(`[Lumen] Extracted ${connections.length} valid connections`);
  return connections;
}

async function scrollAndExtract() {
  // Health check before starting
  const health = runHealthCheck();
  if (!health.healthy) {
    await pauseAndAlert(health.errorType, health.error);
    return [];
  }
  
  const allConnections = new Map();
  let scrollAttempts = 0;
  let previousHeight = 0;
  let noChangeCount = 0;
  
  sendStatus('Starting slow scroll to load all connections...', 'info');
  
  while (scrollAttempts < CONFIG.MAX_SCROLL_ATTEMPTS) {
    scrollAttempts++;
    
    // Periodic health check
    if (scrollAttempts % 10 === 0) {
      const health = runHealthCheck();
      if (!health.healthy) {
        await pauseAndAlert(health.errorType, health.error);
        return Array.from(allConnections.values());
      }
    }
    
    const currentConnections = extractConnectionsFromDOM();
    
    currentConnections.forEach(conn => {
      if (!allConnections.has(conn.profileUrl)) {
        allConnections.set(conn.profileUrl, conn);
      }
    });
    
    sendStatus(`Scroll #${scrollAttempts}: Found ${allConnections.size} unique connections`);
    
    const currentHeight = document.documentElement.scrollHeight;
    
    if (currentHeight === previousHeight) {
      noChangeCount++;
      
      if (noChangeCount >= 3) {
        const isLoading = document.querySelector(SELECTORS.LOADING_INDICATOR);
        
        if (!isLoading) {
          sendStatus('Reached end of connections list', 'success');
          break;
        }
      }
    } else {
      noChangeCount = 0;
    }
    
    previousHeight = currentHeight;
    
    window.scrollBy({
      top: CONFIG.SCROLL_STEP,
      behavior: 'smooth'
    });
    
    const delay = randomDelay(CONFIG.SCROLL_DELAY_MIN, CONFIG.SCROLL_DELAY_MAX);
    await sleep(delay);
    await sleep(CONFIG.EXTRACTION_DELAY);
  }
  
  return Array.from(allConnections.values());
}

// ============================================
// Contact Info Extraction with Error Logging
// ============================================

async function extractContactInfo() {
  const contactInfo = {
    email: null,
    phone: null,
    extractionLog: [], // Log which strategies were tried
  };
  
  console.log('[Lumen] Starting contact info extraction...');
  console.log('[Lumen] Current URL:', window.location.href);
  
  await sleep(CONFIG.PAGE_LOAD_WAIT);
  
  // Health check
  const health = runHealthCheck();
  if (!health.healthy) {
    contactInfo.extractionLog.push({ strategy: 'health-check', result: 'FAILED', reason: health.error });
    return contactInfo;
  }
  
  const isOnContactOverlay = window.location.href.includes('/overlay/contact-info');
  
  console.log('[Lumen] Is on contact overlay:', isOnContactOverlay);
  
  if (!isOnContactOverlay) {
    console.log('[Lumen] Searching for contact info button...');
    let contactButton = null;
    let matchedSelector = null;
    
    // Try selectors in order of past success
    const sortedSelectors = getSortedSelectors('contactButton', SELECTORS.CONTACT_INFO_BUTTON);
    
    for (const selector of sortedSelectors) {
      contactButton = document.querySelector(selector);
      if (contactButton) {
        matchedSelector = selector;
        recordSelectorSuccess('contactButton', selector);
        contactInfo.extractionLog.push({ strategy: 'button-selector', selector, result: 'FOUND' });
        break;
      } else {
        contactInfo.extractionLog.push({ strategy: 'button-selector', selector, result: 'NOT_FOUND' });
      }
    }
    
    // Fallback: Find by text content "Contact info"
    if (!contactButton) {
      console.log('[Lumen] Trying to find button by text content...');
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        if (link.textContent.trim() === 'Contact info') {
          contactButton = link;
          matchedSelector = 'text-content-search';
          recordSelectorSuccess('contactButton', 'text:Contact info');
          contactInfo.extractionLog.push({ strategy: 'text-content-search', result: 'FOUND' });
          console.log('[Lumen] Found contact button by text content!');
          break;
        }
      }
    }
    
    if (!contactButton) {
      console.error('[Lumen] ❌ Contact info button NOT FOUND after trying all selectors');
      logError(ERROR_TYPES.SELECTOR_FAILED, {
        message: 'Contact info button not found',
        selectors_tried: SELECTORS.CONTACT_INFO_BUTTON,
        page_url: window.location.href,
      });
      
      // Try direct navigation as fallback
      console.log('[Lumen] Attempting direct navigation to contact info...');
      sendStatus('Contact button not found, trying direct URL...', 'info');
      const currentUrl = window.location.href.replace(/\/$/, '').replace(/\/overlay\/.*$/, '');
      const contactUrl = currentUrl + '/overlay/contact-info/';
      console.log('[Lumen] Navigating to:', contactUrl);
      window.location.href = contactUrl;
      await sleep(CONFIG.CONTACT_MODAL_WAIT + 2000);
      contactInfo.extractionLog.push({ strategy: 'direct-navigation', url: contactUrl });
      return contactInfo;
    }
    
    console.log('[Lumen] ✓ Found contact button with selector:', matchedSelector);
    console.log('[Lumen] Clicking contact info button...');
    contactButton.click();
    await sleep(CONFIG.CONTACT_MODAL_WAIT);
  }
  
  await sleep(1500);
  
  // ===== Email Extraction with Logging =====
  
  // Strategy 1: mailto links
  let emailElement = document.querySelector('a[href^="mailto:"]');
  if (emailElement) {
    const href = emailElement.getAttribute('href') || '';
    contactInfo.email = href.replace('mailto:', '').split('?')[0].trim();
    contactInfo.extractionLog.push({ strategy: 'email-mailto', result: 'FOUND', value: contactInfo.email });
  } else {
    contactInfo.extractionLog.push({ strategy: 'email-mailto', result: 'NOT_FOUND' });
  }
  
  // Strategy 2: Email pattern in links
  if (!contactInfo.email) {
    const allLinks = document.querySelectorAll('a');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    for (const link of allLinks) {
      const text = link.textContent.trim();
      if (emailRegex.test(text)) {
        contactInfo.email = text;
        contactInfo.extractionLog.push({ strategy: 'email-regex-link', result: 'FOUND', value: text });
        break;
      }
    }
    if (!contactInfo.email) {
      contactInfo.extractionLog.push({ strategy: 'email-regex-link', result: 'NOT_FOUND' });
    }
  }
  
  // Strategy 3: Section with "Email" label
  if (!contactInfo.email) {
    const sections = document.querySelectorAll('section, div[class*="ci-"], div[class*="contact"]');
    let found = false;
    
    for (const section of sections) {
      const text = section.textContent.toLowerCase();
      if (text.includes('email')) {
        const links = section.querySelectorAll('a');
        for (const link of links) {
          const linkText = link.textContent.trim();
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (emailRegex.test(linkText) || link.href?.startsWith('mailto:')) {
            contactInfo.email = link.href?.startsWith('mailto:') 
              ? link.href.replace('mailto:', '').split('?')[0].trim()
              : linkText;
            contactInfo.extractionLog.push({ strategy: 'email-section-search', result: 'FOUND', value: contactInfo.email });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
    if (!found) {
      contactInfo.extractionLog.push({ strategy: 'email-section-search', result: 'NOT_FOUND' });
    }
  }
  
  // ===== Phone Extraction with Logging =====
  
  // Strategy 1: tel links
  let phoneElement = document.querySelector('a[href^="tel:"]');
  if (phoneElement) {
    contactInfo.phone = phoneElement.textContent.trim() || 
                        phoneElement.href.replace('tel:', '').trim();
    contactInfo.extractionLog.push({ strategy: 'phone-tel', result: 'FOUND', value: contactInfo.phone });
  } else {
    contactInfo.extractionLog.push({ strategy: 'phone-tel', result: 'NOT_FOUND' });
  }
  
  // Strategy 2: Phone pattern in sections
  if (!contactInfo.phone) {
    const phoneRegex = /[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,3}[)]?[-\s\.]?[0-9]{3,4}[-\s\.]?[0-9]{3,6}/;
    const sections = document.querySelectorAll('section, div[class*="ci-"], div[class*="contact"]');
    let found = false;
    
    for (const section of sections) {
      const text = section.textContent.toLowerCase();
      if (text.includes('phone') || text.includes('mobile')) {
        const spans = section.querySelectorAll('span, div, a');
        for (const span of spans) {
          const spanText = span.textContent.trim();
          if (phoneRegex.test(spanText) && spanText.length > 6 && spanText.length < 20) {
            contactInfo.phone = spanText;
            contactInfo.extractionLog.push({ strategy: 'phone-section-search', result: 'FOUND', value: spanText });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
    if (!found) {
      contactInfo.extractionLog.push({ strategy: 'phone-section-search', result: 'NOT_FOUND' });
    }
  }
  
  // Try alternative extraction from profile text if nothing found
  if (!contactInfo.email && !contactInfo.phone) {
    const alternativeInfo = extractContactFromProfileText();
    if (alternativeInfo.email) contactInfo.email = alternativeInfo.email;
    if (alternativeInfo.phone) contactInfo.phone = alternativeInfo.phone;
    
    if (alternativeInfo.email || alternativeInfo.phone) {
      contactInfo.extractionLog.push({ strategy: 'profile-text-fallback', result: 'FOUND' });
    } else {
      logError(ERROR_TYPES.SELECTOR_FAILED, {
        message: 'No contact info extracted',
        extraction_log: contactInfo.extractionLog,
        page_url: window.location.href,
      });
    }
  }
  
  // Close modal
  const closeButton = document.querySelector('button[aria-label="Dismiss"], button[data-test-modal-close-btn]');
  if (closeButton) {
    closeButton.click();
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
  }
  await sleep(500);
  
  console.log(`[Lumen] Contact extraction complete:`, contactInfo);
  return contactInfo;
}

function extractContactFromProfileText() {
  const contactInfo = { email: null, phone: null };
  
  // Try to find email/phone in visible text as last resort
  const bodyText = document.body?.innerText || '';
  
  // Email pattern
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
  const emailMatch = bodyText.match(emailRegex);
  if (emailMatch && emailMatch[0]) {
    contactInfo.email = emailMatch[0];
  }
  
  // Phone pattern
  const phoneRegex = /\+?\d{1,4}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9}/g;
  const phoneMatches = bodyText.match(phoneRegex);
  if (phoneMatches) {
    // Filter likely phone numbers (not years, etc.)
    const validPhone = phoneMatches.find(p => p.replace(/\D/g, '').length >= 10);
    if (validPhone) contactInfo.phone = validPhone;
  }
  
  return contactInfo;
}

// ============================================
// Profile Scraping with Retry Logic
// ============================================

async function scrapeProfiles(connections, startIndex = 0, failedProfiles = []) {
  const total = connections.length;
  
  sendStatus(`Starting profile scraping from ${startIndex + 1}/${total}`, 'info');
  
  for (let i = startIndex; i < total; i++) {
    const conn = connections[i];
    
    if (conn.scraped) {
      continue;
    }
    
    // Health check before each profile
    const health = runHealthCheck();
    if (!health.healthy) {
      await pauseAndAlert(health.errorType, health.error);
      await saveProgress(connections, i, failedProfiles);
      return;
    }
    
    sendStatus(`[${i + 1}/${total}] Visiting: ${conn.name}`, 'info');
    
    // Save progress before navigation
    await saveProgress(connections, i, failedProfiles);
    
    // Reset flag before navigation as script will restart
    isExecuting = false;
    
    // Navigate to profile
    window.location.href = conn.profileUrl;
    return; // Script restarts on new page
  }
  
  // All done
  sendStatus('All profiles scraped!', 'success');
  
  if (failedProfiles.length > 0) {
    sendStatus(`⚠️ ${failedProfiles.length} profiles failed extraction`, 'info');
  }
  
  await clearProgress();
  
  chrome.runtime.sendMessage({
    type: 'SCRAPING_COMPLETE',
    connections: connections,
    failedProfiles: failedProfiles,
  });
}

async function handleProfilePage() {
  if (isExecuting) {
    console.log('[Lumen] Already executing profile scrape, skipping duplicate');
    return;
  }
  
  const progress = await loadProgress();
  
  if (!progress) {
    console.log('[Lumen] No active scraping session');
    return;
  }
  
  isExecuting = true;
  
  const { connections, currentIndex, failedProfiles = [] } = progress;
  const conn = connections[currentIndex];
  
  console.log(`[Lumen] Handling profile page for: ${conn.name}`);
  
  // Health check first
  const health = runHealthCheck();
  if (!health.healthy) {
    await pauseAndAlert(health.errorType, health.error);
    isExecuting = false;
    return;
  }
  
  // Wait for page load with retry check
  const loadResult = await waitForPageLoad();
  
  if (!loadResult.success) {
    conn.retryCount = (conn.retryCount || 0) + 1;
    
    if (conn.retryCount < CONFIG.MAX_RETRIES) {
      sendStatus(`Page load failed for ${conn.name}, retry ${conn.retryCount}/${CONFIG.MAX_RETRIES}`, 'info');
      await sleep(CONFIG.RETRY_DELAY);
      
      // Retry by saving state and renavigating
      await saveProgress(connections, currentIndex, failedProfiles);
      isExecuting = false; // Reset before navigation
      window.location.href = conn.profileUrl;
      return;
    } else {
      // Max retries reached, mark as failed and continue
      sendStatus(`⚠️ Skipping ${conn.name} after ${CONFIG.MAX_RETRIES} failed attempts`, 'error');
      logError(ERROR_TYPES.PAGE_LOAD_FAILED, {
        profile: conn.name,
        url: conn.profileUrl,
        retries: conn.retryCount,
      });
      
      conn.scraped = true; // Mark as processed (but failed)
      failedProfiles.push({
        name: conn.name,
        profileUrl: conn.profileUrl,
        reason: 'Page load failed after retries',
      });
      
      await saveProgress(connections, currentIndex + 1, failedProfiles);
      
      // Continue to next profile after delay
      const delay = randomDelay(CONFIG.PROFILE_DELAY_MIN, CONFIG.PROFILE_DELAY_MAX);
      await sleep(delay);
      await scrapeProfiles(connections, currentIndex + 1, failedProfiles);
      return;
    }
  }
  
  sendStatus(`Extracting contact info for: ${conn.name}`, 'info');
  
  // Wait a bit more for page to fully render
  await sleep(2000);
  
  // Extract contact info
  const contactInfo = await extractContactInfo();
  
  // Update connection data
  conn.email = contactInfo.email;
  conn.phone = contactInfo.phone;
  conn.scraped = true;
  conn.extractionLog = contactInfo.extractionLog;
  
  // Send individual contact to Telegram
  chrome.runtime.sendMessage({
    type: 'SEND_CONTACT_TO_TELEGRAM',
    contact: {
      name: conn.name,
      profileUrl: conn.profileUrl,
      email: conn.email,
      phone: conn.phone,
      index: currentIndex + 1,
      total: connections.length
    }
  });
  
  // Save progress
  await saveProgress(connections, currentIndex + 1, failedProfiles);
  
  // Wait before next profile with adaptive delays
  const delay = randomDelay(adaptiveDelayMin, adaptiveDelayMax);
  const avgLoadTime = pageLoadTimes.length > 0 
    ? Math.round(pageLoadTimes.reduce((a, b) => a + b, 0) / pageLoadTimes.length / 1000)
    : 0;
  sendStatus(`Waiting ${Math.round(delay / 1000)}s before next profile... (avg load: ${avgLoadTime}s)`, 'info');
  await sleep(delay);
  
  // Continue to next profile
  if (currentIndex + 1 < connections.length) {
    await scrapeProfiles(connections, currentIndex + 1, failedProfiles);
  } else {
    sendStatus('All profiles scraped!', 'success');
    
    if (failedProfiles.length > 0) {
      sendStatus(`⚠️ ${failedProfiles.length} profiles failed`, 'info');
    }
    
    await clearProgress();
    
    chrome.runtime.sendMessage({
      type: 'SCRAPING_COMPLETE',
      connections: connections,
      failedProfiles: failedProfiles,
    });
  }
}

// ============================================
// Main Entry Points
// ============================================

async function runListExtraction() {
  if (isExecuting) {
    console.log('[Lumen] Already executing, skipping duplicate call');
    return;
  }
  
  isExecuting = true;
  
  try {
    // Wait a bit if page just loaded
    await sleep(2000);
    
    sendStatus('Validating page...', 'info');
    
    // Health check
    const health = runHealthCheck();
    if (!health.healthy) {
      await pauseAndAlert(health.errorType, health.error);
      return;
    }
    
    if (!window.location.href.includes('linkedin.com/mynetwork/invite-connect/connections')) {
      throw new Error('Not on LinkedIn Connections page');
    }
    
    const connections = await scrollAndExtract();
    
    if (connections.length === 0) {
      sendStatus('No connections found. Check if logged in.', 'error');
      chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', error: 'No connections found' });
      return;
    }
    
    sendStatus(`Found ${connections.length} connections. Sending to Telegram...`, 'success');
    
    chrome.runtime.sendMessage({
      type: 'SEND_TO_TELEGRAM',
      connections: connections
    });
    
    chrome.runtime.sendMessage({
      type: 'EXTRACTION_COMPLETE',
      count: connections.length,
      connections: connections
    });
    
  } catch (err) {
    sendStatus(`Extraction failed: ${err.message}`, 'error');
    chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', error: err.message });
  } finally {
    isExecuting = false;
  }
}

async function runFullScrape() {
  if (isExecuting) {
    console.log('[Lumen] Already executing, skipping duplicate call');
    return;
  }
  
  isExecuting = true;
  
  try {
    // Wait a bit if page just loaded
    await sleep(2000);
    
    sendStatus('Starting full scrape (list + profiles)...', 'info');
    
    // Health check
    const health = runHealthCheck();
    if (!health.healthy) {
      await pauseAndAlert(health.errorType, health.error);
      return;
    }
    
    if (!window.location.href.includes('linkedin.com/mynetwork/invite-connect/connections')) {
      throw new Error('Not on LinkedIn Connections page.');
    }
    
    const connections = await scrollAndExtract();
    
    if (connections.length === 0) {
      sendStatus('No connections found.', 'error');
      return;
    }
    
    sendStatus(`Found ${connections.length} connections. Starting profile scraping...`, 'info');
    sendStatus(`⚠️ ETA: ~${Math.round(connections.length * 75 / 60)} minutes`, 'info');
    
    await scrapeProfiles(connections, 0, []);
    
  } catch (err) {
    sendStatus(`Scrape failed: ${err.message}`, 'error');
  } finally {
    isExecuting = false;
  }
}

async function resumeScrape() {
  if (isExecuting) {
    console.log('[Lumen] Already executing, skipping duplicate call');
    return;
  }
  
  const progress = await loadProgress();
  
  if (!progress) {
    sendStatus('No scraping session to resume', 'info');
    return;
  }
  
  isExecuting = true;
  
  // Health check before resuming
  const health = runHealthCheck();
  if (!health.healthy) {
    await pauseAndAlert(health.errorType, health.error);
    isExecuting = false;
    return;
  }
  
  const { connections, currentIndex, failedProfiles } = progress;
  sendStatus(`Resuming from ${currentIndex + 1}/${connections.length}`, 'info');
  
  await scrapeProfiles(connections, currentIndex, failedProfiles);
}

// ============================================
// Message Listener
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (window.lumenScriptLoaded !== true) {
    console.log('[Lumen] Script not initialized, ignoring message');
    return;
  }
  
  switch (message.action) {
    case 'START_EXTRACTION':
      runListExtraction();
      sendResponse({ status: 'started' });
      break;
      
    case 'START_FULL_SCRAPE':
      runFullScrape();
      sendResponse({ status: 'started' });
      break;
      
    case 'RESUME_SCRAPE':
      resumeScrape();
      sendResponse({ status: 'resumed' });
      break;
      
    case 'STOP_SCRAPE':
      clearProgress();
      sendResponse({ status: 'stopped' });
      break;
  }
  return true;
});

// ============================================
// Auto-detection on Page Load
// ============================================

(async function init() {
  // Double-check we're the only instance
  if (window.lumenScriptLoaded !== true) {
    console.log('[Lumen] Script guard failed, aborting init');
    return;
  }
  
  console.log('[Lumen] Content script loaded on:', window.location.href);
  
  // Load selector statistics
  await loadSelectorStats();
  
  // Wait for page to settle
  await sleep(2000);
  
  // Run health check on every page load
  const health = runHealthCheck();
  if (!health.healthy) {
    console.log(`[Lumen] Health check failed: ${health.error}`);
    // Don't auto-pause here, let user see the issue
  }
  
  // Check if on profile page with active session
  if (window.location.href.includes('/in/') && 
      !window.location.href.includes('/mynetwork/')) {
    
    const progress = await loadProgress();
    if (progress) {
      console.log('[Lumen] Active scraping session detected, continuing...');
      await sleep(2000);
      await handleProfilePage();
    }
  }
})();
