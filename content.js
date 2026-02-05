/**
 * content.js - LinkedIn Connections & Contact Scraper
 * 
 * Phase 1: Scroll and collect connections list (name + profile URL)
 * Phase 2: Visit each profile, extract contact info (email, phone)
 * 
 * IMPORTANT: This script does NOT make any network calls directly.
 * All external API calls go through background.js
 */

// ============================================
// Configuration
// ============================================

const CONFIG = {
  // Scroll settings (slow to avoid detection)
  SCROLL_STEP: 800,
  SCROLL_DELAY_MIN: 2000,
  SCROLL_DELAY_MAX: 4000,
  MAX_SCROLL_ATTEMPTS: 200,
  EXTRACTION_DELAY: 500,
  
  // Profile scraping settings
  PROFILE_DELAY_MIN: 60000,     // 60 seconds minimum between profiles
  PROFILE_DELAY_MAX: 90000,     // 90 seconds maximum
  PAGE_LOAD_WAIT: 3000,         // Wait for page to load
  CONTACT_MODAL_WAIT: 2000,     // Wait for contact modal to open
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
  
  // Profile page - Contact info button
  // LinkedIn has a "Contact info" link in the intro section
  CONTACT_INFO_BUTTON: [
    'a[href*="/overlay/contact-info"]',
    '#top-card-text-details-contact-info',
    'a[data-control-name="contact_see_more"]',
    '.pv-text-details__separator + a',
  ],
  
  // Contact info modal selectors
  CONTACT_MODAL: '.pv-contact-info',
  EMAIL_SECTION: 'section.ci-email a[href^="mailto:"]',
  PHONE_SECTION: 'section.ci-phone .t-14',
  WEBSITE_SECTION: 'section.ci-websites a',
  
  // Alternative contact modal selectors (LinkedIn updates frequently)
  EMAIL_ALT: 'a[href^="mailto:"]',
  PHONE_ALT: '.pv-contact-info__ci-container .t-14.t-black',
};

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

// ============================================
// State Management (for resume capability)
// ============================================

async function saveProgress(connections, currentIndex) {
  await chrome.storage.local.set({
    lumen_connections: connections,
    lumen_current_index: currentIndex,
    lumen_timestamp: Date.now()
  });
}

async function loadProgress() {
  const data = await chrome.storage.local.get([
    'lumen_connections',
    'lumen_current_index',
    'lumen_timestamp'
  ]);
  
  // Expire after 24 hours
  if (data.lumen_timestamp && Date.now() - data.lumen_timestamp > 24 * 60 * 60 * 1000) {
    await clearProgress();
    return null;
  }
  
  if (data.lumen_connections && data.lumen_current_index !== undefined) {
    return {
      connections: data.lumen_connections,
      currentIndex: data.lumen_current_index
    };
  }
  return null;
}

async function clearProgress() {
  await chrome.storage.local.remove([
    'lumen_connections',
    'lumen_current_index',
    'lumen_timestamp'
  ]);
}

// ============================================
// Connections List Extraction
// ============================================

function extractConnectionsFromDOM() {
  const connections = [];
  const seenUrls = new Set();
  
  const profileLinks = document.querySelectorAll('a[href*="/in/"]');
  console.log(`[Lumen] Found ${profileLinks.length} profile links to process`);
  
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
      
      const ariaHiddenSpan = linkEl.querySelector('span[aria-hidden="true"]');
      if (ariaHiddenSpan) {
        name = ariaHiddenSpan.textContent.trim();
      }
      
      if (!name) {
        const container = linkEl.closest('li') || linkEl.closest('[class*="card"]') || linkEl.parentElement;
        if (container) {
          const nameSpan = container.querySelector('span[aria-hidden="true"]');
          if (nameSpan) {
            name = nameSpan.textContent.trim();
          }
        }
      }
      
      if (!name) {
        name = linkEl.textContent.trim().split('\n')[0].trim();
      }
      
      if (!name) {
        name = linkEl.getAttribute('aria-label') || '';
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
        email: null,
        phone: null,
        scraped: false
      });
      
    } catch (err) {
      console.warn('[Lumen] Error extracting connection:', err);
    }
  });
  
  console.log(`[Lumen] Extracted ${connections.length} valid connections`);
  return connections;
}

async function scrollAndExtract() {
  const allConnections = new Map();
  let scrollAttempts = 0;
  let previousHeight = 0;
  let noChangeCount = 0;
  
  sendStatus('Starting slow scroll to load all connections...', 'info');
  
  while (scrollAttempts < CONFIG.MAX_SCROLL_ATTEMPTS) {
    scrollAttempts++;
    
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
// Contact Info Extraction (Profile Page)
// ============================================

/**
 * Extract contact info from the current profile page
 * Must be called when on a profile page
 * 
 * LinkedIn 2025/2026 contact modal structure:
 * - Modal appears at /overlay/contact-info/ URL
 * - Email is in a section with an envelope icon
 * - Phone is in a section with a phone icon
 * - Each section has the label and value
 */
async function extractContactInfo() {
  const contactInfo = {
    email: null,
    phone: null
  };
  
  // Wait for page to stabilize
  await sleep(CONFIG.PAGE_LOAD_WAIT);
  
  // Check if we're already on the contact-info overlay
  const isOnContactOverlay = window.location.href.includes('/overlay/contact-info');
  
  if (!isOnContactOverlay) {
    // Try to find and click the "Contact info" button
    let contactButton = null;
    
    const contactButtonSelectors = [
      'a[href*="/overlay/contact-info"]',
      '#top-card-text-details-contact-info',
      'a[data-control-name="contact_see_more"]',
      '.pv-text-details__separator + a',
      // New selectors for 2025/2026
      '[data-test-id="contact-info-cta"]',
      'a[href*="contact-info"]',
    ];
    
    for (const selector of contactButtonSelectors) {
      contactButton = document.querySelector(selector);
      if (contactButton) {
        console.log(`[Lumen] Found contact button with selector: ${selector}`);
        break;
      }
    }
    
    if (!contactButton) {
      console.log('[Lumen] Contact info button not found, trying to navigate directly');
      // Try navigating directly to contact-info overlay
      const currentUrl = window.location.href.replace(/\/$/, '');
      const contactUrl = currentUrl + '/overlay/contact-info/';
      window.location.href = contactUrl;
      await sleep(CONFIG.CONTACT_MODAL_WAIT + 2000);
      return contactInfo; // Will be re-extracted after navigation
    }
    
    // Click to open contact modal
    contactButton.click();
    await sleep(CONFIG.CONTACT_MODAL_WAIT);
  }
  
  // Wait a bit more for modal content to load
  await sleep(1500);
  
  // ============================================
  // Extract Email - Multiple strategies
  // ============================================
  
  // Strategy 1: Look for mailto: links
  let emailElement = document.querySelector('a[href^="mailto:"]');
  if (emailElement) {
    const href = emailElement.getAttribute('href') || '';
    contactInfo.email = href.replace('mailto:', '').split('?')[0].trim();
    console.log(`[Lumen] Found email via mailto: ${contactInfo.email}`);
  }
  
  // Strategy 2: Look for email pattern in visible text
  if (!contactInfo.email) {
    // Find all links/text in the modal and look for email patterns
    const allLinks = document.querySelectorAll('a');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    for (const link of allLinks) {
      const text = link.textContent.trim();
      if (emailRegex.test(text)) {
        contactInfo.email = text;
        console.log(`[Lumen] Found email via text pattern: ${contactInfo.email}`);
        break;
      }
    }
  }
  
  // Strategy 3: Look for section with "Email" label
  if (!contactInfo.email) {
    const sections = document.querySelectorAll('section, div[class*="ci-"], div[class*="contact"]');
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
            console.log(`[Lumen] Found email in section: ${contactInfo.email}`);
            break;
          }
        }
        if (contactInfo.email) break;
      }
    }
  }
  
  // ============================================
  // Extract Phone - Multiple strategies
  // ============================================
  
  // Strategy 1: Look for tel: links
  let phoneElement = document.querySelector('a[href^="tel:"]');
  if (phoneElement) {
    contactInfo.phone = phoneElement.textContent.trim() || 
                        phoneElement.href.replace('tel:', '').trim();
    console.log(`[Lumen] Found phone via tel: ${contactInfo.phone}`);
  }
  
  // Strategy 2: Look for phone pattern in text
  if (!contactInfo.phone) {
    const phoneRegex = /[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,3}[)]?[-\s\.]?[0-9]{3,4}[-\s\.]?[0-9]{3,6}/;
    const sections = document.querySelectorAll('section, div[class*="ci-"], div[class*="contact"]');
    
    for (const section of sections) {
      const text = section.textContent.toLowerCase();
      if (text.includes('phone') || text.includes('mobile')) {
        const spans = section.querySelectorAll('span, div, a');
        for (const span of spans) {
          const spanText = span.textContent.trim();
          if (phoneRegex.test(spanText) && spanText.length > 6 && spanText.length < 20) {
            contactInfo.phone = spanText;
            console.log(`[Lumen] Found phone in section: ${contactInfo.phone}`);
            break;
          }
        }
        if (contactInfo.phone) break;
      }
    }
  }
  
  // Close modal by pressing Escape or clicking X button
  const closeButton = document.querySelector('button[aria-label="Dismiss"], button[data-test-modal-close-btn]');
  if (closeButton) {
    closeButton.click();
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
  }
  await sleep(500);
  
  console.log(`[Lumen] Extracted contact info:`, contactInfo);
  return contactInfo;
}

// ============================================
// Profile Scraping Loop
// ============================================

async function scrapeProfiles(connections, startIndex = 0) {
  const total = connections.length;
  
  sendStatus(`Starting profile scraping from index ${startIndex}/${total}`, 'info');
  
  for (let i = startIndex; i < total; i++) {
    const conn = connections[i];
    
    if (conn.scraped) {
      continue; // Already processed
    }
    
    sendStatus(`[${i + 1}/${total}] Visiting: ${conn.name}`, 'info');
    
    // Navigate to profile
    window.location.href = conn.profileUrl;
    
    // Wait for navigation and page load
    // Note: This will reload the page, so the script will restart.
    // We save progress before navigating.
    await saveProgress(connections, i);
    
    // The page will reload here, so we return.
    // When the content script loads on the profile page, 
    // it will continue from where it left off.
    return;
  }
  
  // All done!
  sendStatus('All profiles scraped!', 'success');
  await clearProgress();
  
  chrome.runtime.sendMessage({
    type: 'SCRAPING_COMPLETE',
    connections: connections
  });
}

/**
 * Handle profile page - extract contact info and continue
 */
async function handleProfilePage() {
  const progress = await loadProgress();
  
  if (!progress) {
    console.log('[Lumen] No active scraping session');
    return;
  }
  
  const { connections, currentIndex } = progress;
  const conn = connections[currentIndex];
  
  sendStatus(`Extracting contact info for: ${conn.name}`, 'info');
  
  // Extract contact info
  const contactInfo = await extractContactInfo();
  
  // Update connection data
  conn.email = contactInfo.email;
  conn.phone = contactInfo.phone;
  conn.scraped = true;
  
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
  await saveProgress(connections, currentIndex + 1);
  
  // Wait the required delay before next profile (60-90 seconds)
  const delay = randomDelay(CONFIG.PROFILE_DELAY_MIN, CONFIG.PROFILE_DELAY_MAX);
  sendStatus(`Waiting ${Math.round(delay / 1000)}s before next profile...`, 'info');
  await sleep(delay);
  
  // Continue to next profile
  if (currentIndex + 1 < connections.length) {
    await scrapeProfiles(connections, currentIndex + 1);
  } else {
    sendStatus('All profiles scraped!', 'success');
    await clearProgress();
    
    chrome.runtime.sendMessage({
      type: 'SCRAPING_COMPLETE',
      connections: connections
    });
  }
}

// ============================================
// Main Entry Points
// ============================================

async function runListExtraction() {
  try {
    sendStatus('Validating page...', 'info');
    
    if (!window.location.href.includes('linkedin.com/mynetwork/invite-connect/connections')) {
      throw new Error('Not on LinkedIn Connections page');
    }
    
    const connections = await scrollAndExtract();
    
    if (connections.length === 0) {
      sendStatus('No connections found. Make sure you are logged in.', 'error');
      chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', error: 'No connections found' });
      return;
    }
    
    sendStatus(`Found ${connections.length} connections. Sending list to Telegram...`, 'success');
    
    // Send connections list to Telegram (without contact info yet)
    chrome.runtime.sendMessage({
      type: 'SEND_TO_TELEGRAM',
      connections: connections
    });
    
    chrome.runtime.sendMessage({
      type: 'EXTRACTION_COMPLETE',
      count: connections.length
    });
    
  } catch (err) {
    sendStatus(`Extraction failed: ${err.message}`, 'error');
    chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', error: err.message });
  }
}

async function runFullScrape() {
  try {
    sendStatus('Starting full scrape (list + profiles)...', 'info');
    
    if (!window.location.href.includes('linkedin.com/mynetwork/invite-connect/connections')) {
      throw new Error('Not on LinkedIn Connections page. Please navigate there first.');
    }
    
    // First, collect all connections
    const connections = await scrollAndExtract();
    
    if (connections.length === 0) {
      sendStatus('No connections found.', 'error');
      return;
    }
    
    sendStatus(`Found ${connections.length} connections. Starting profile scraping...`, 'info');
    sendStatus(`⚠️ This will take ~${Math.round(connections.length * 75 / 60)} minutes`, 'info');
    
    // Start profile scraping
    await scrapeProfiles(connections, 0);
    
  } catch (err) {
    sendStatus(`Scrape failed: ${err.message}`, 'error');
  }
}

async function resumeScrape() {
  const progress = await loadProgress();
  
  if (!progress) {
    sendStatus('No scraping session to resume', 'info');
    return;
  }
  
  const { connections, currentIndex } = progress;
  sendStatus(`Resuming scrape from ${currentIndex + 1}/${connections.length}`, 'info');
  
  await scrapeProfiles(connections, currentIndex);
}

// ============================================
// Message Listener
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'START_EXTRACTION':
      // Original: just list extraction
      runListExtraction();
      sendResponse({ status: 'started' });
      break;
      
    case 'START_FULL_SCRAPE':
      // New: list + profile scraping
      runFullScrape();
      sendResponse({ status: 'started' });
      break;
      
    case 'RESUME_SCRAPE':
      // Resume from saved progress
      resumeScrape();
      sendResponse({ status: 'resumed' });
      break;
      
    case 'STOP_SCRAPE':
      // Clear progress to stop
      clearProgress();
      sendResponse({ status: 'stopped' });
      break;
  }
  return true;
});

// ============================================
// Auto-detection: Continue scraping if on a profile page
// ============================================

(async function init() {
  console.log('[Lumen] Content script loaded on:', window.location.href);
  
  // Check if we're on a profile page and have an active scraping session
  if (window.location.href.includes('/in/') && 
      !window.location.href.includes('/mynetwork/')) {
    
    const progress = await loadProgress();
    if (progress) {
      console.log('[Lumen] Detected active scraping session, continuing...');
      // Small delay to let page fully load
      await sleep(2000);
      await handleProfilePage();
    }
  }
})();
