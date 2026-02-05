/**
 * content.js - LinkedIn Scraper (CLEAN REWRITE)
 * Simple, reliable scraping without over-engineering
 */

// ============================================
// Prevent Multiple Instances
// ============================================
if (window.lumenRunning) {
  console.log('[Lumen] Already running, stopping duplicate');
  throw new Error('Duplicate instance blocked');
}
window.lumenRunning = true;

// ============================================
// Simple Configuration
// ============================================
const CONFIG = {
  SCROLL_DELAY: 3000,
  PROFILE_DELAY: 75000, // 75 seconds between profiles
  PAGE_WAIT: 4000,
  MODAL_WAIT: 3000,
  MAX_RETRIES: 2,
};

// ============================================
// Utility Functions
// ============================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`[Lumen] ${msg}`);
  chrome.runtime.sendMessage({ type: 'STATUS', text: msg });
}

function logError(msg) {
  console.error(`[Lumen] ${msg}`);
  chrome.runtime.sendMessage({ type: 'STATUS', text: msg, level: 'error' });
}

// ============================================
// Storage Functions
// ============================================
async function saveProgress(connections, index) {
  await chrome.storage.local.set({
    lumen_connections: connections,
    lumen_index: index,
    lumen_timestamp: Date.now()
  });
}

async function loadProgress() {
  const data = await chrome.storage.local.get(['lumen_connections', 'lumen_index', 'lumen_timestamp']);
  if (data.lumen_connections && data.lumen_index !== undefined) {
    return { connections: data.lumen_connections, index: data.lumen_index };
  }
  return null;
}

async function clearProgress() {
  await chrome.storage.local.remove(['lumen_connections', 'lumen_index', 'lumen_timestamp']);
}

// ============================================
// Extraction: Scroll and Get Connections
// ============================================
async function extractConnectionsList() {
  log('Starting connections extraction...');
  
  const connections = new Map();
  let noChangeCount = 0;
  let scrolls = 0;
  
  while (scrolls < 100 && noChangeCount < 3) {
    scrolls++;
    
    // Find all profile links
    const links = document.querySelectorAll('a[href*="/in/"]');
    const startCount = connections.size;
    
    links.forEach(link => {
      const url = link.href.split('?')[0].replace(/\/$/, '');
      if (!url.includes('/in/')) return;
      
      // Get name from link text or nearby span
      let name = link.textContent.trim();
      const span = link.querySelector('span[aria-hidden="true"]');
      if (span) name = span.textContent.trim();
      
      name = name.replace(/^View\s+/i, '').replace(/['']s profile$/i, '').trim();
      
      if (name && name.length > 2 && !name.toLowerCase().includes('message')) {
        connections.set(url, { name, profileUrl: url, email: null, phone: null });
      }
    });
    
    if (connections.size === startCount) {
      noChangeCount++;
    } else {
      noChangeCount = 0;
    }
    
    log(`Scroll ${scrolls}: Found ${connections.size} connections`);
    
    window.scrollBy({ top: 800, behavior: 'smooth' });
    await sleep(CONFIG.SCROLL_DELAY);
  }
  
  const result = Array.from(connections.values());
  log(`Extraction complete: ${result.length} connections`);
  return result;
}

// ============================================
// Contact Info Extraction
// ============================================
async function extractContactInfo() {
  log('Extracting contact info...');
  await sleep(CONFIG.PAGE_WAIT);
  
  // Find contact info button by text
  let button = null;
  const links = document.querySelectorAll('a');
  for (const link of links) {
    if (link.textContent.trim().toLowerCase().includes('contact info')) {
      button = link;
      break;
    }
  }
  
  if (!button) {
    log('Contact button not found, trying direct URL...');
    const baseUrl = window.location.href.split('?')[0].replace(/\/$/, '');
    window.location.href = baseUrl + '/overlay/contact-info/';
    await sleep(CONFIG.MODAL_WAIT);
  } else {
    log('Clicking contact info button...');
    button.click();
    await sleep(CONFIG.MODAL_WAIT);
  }
  
  // Extract email
  let email = null;
  const mailtoLink = document.querySelector('a[href^="mailto:"]');
  if (mailtoLink) {
    email = mailtoLink.href.replace('mailto:', '').split('?')[0];
  }
  
  // Extract phone
  let phone = null;
  const telLink = document.querySelector('a[href^="tel:"]');
  if (telLink) {
    phone = telLink.textContent.trim();
  }
  
  log(`Extracted - Email: ${email || 'none'}, Phone: ${phone || 'none'}`);
  
  return { email, phone };
}

// ============================================
// Profile Scraping
// ============================================
async function scrapeProfile(connection, index, total) {
  log(`[${index + 1}/${total}] Scraping: ${connection.name}`);
  
  // Navigate to profile
  window.location.href = connection.profileUrl;
  // Script will restart on new page
}

async function continueProfileScraping() {
  const progress = await loadProgress();
  if (!progress) {
    log('No scraping in progress');
    return;
  }
  
  const { connections, index } = progress;
  const conn = connections[index];
  
  log(`Resuming profile ${index + 1}/${connections.length}: ${conn.name}`);
  
  // Wait for page to load
  await sleep(CONFIG.PAGE_WAIT);
  
  // Check if we're on the right page
  if (!window.location.href.includes('/in/')) {
    logError('Not on a profile page!');
    return;
  }
  
  // Extract contact info
  const { email, phone } = await extractContactInfo();
  conn.email = email;
  conn.phone = phone;
  
  // Send to Telegram
  chrome.runtime.sendMessage({
    type: 'SEND_CONTACT_TO_TELEGRAM',
    contact: {
      name: conn.name,
      profileUrl: conn.profileUrl,
      email: email,
      phone: phone,
      index: index + 1,
      total: connections.length
    }
  });
  
  // Move to next
  const nextIndex = index + 1;
  if (nextIndex < connections.length) {
    await saveProgress(connections, nextIndex);
    log(`Waiting ${CONFIG.PROFILE_DELAY / 1000}s before next profile...`);
    await sleep(CONFIG.PROFILE_DELAY);
    await scrapeProfile(connections[nextIndex], nextIndex, connections.length);
  } else {
    // Done!
    log('All profiles scraped!');
    await clearProgress();
    chrome.runtime.sendMessage({
      type: 'SCRAPING_COMPLETE',
      connections: connections,
      failedProfiles: []
    });
  }
}

// ============================================
// Main Actions
// ============================================
async function startListExtraction() {
  log('Starting list extraction...');
  
  if (!window.location.href.includes('linkedin.com/mynetwork/invite-connect/connections')) {
    logError('Not on connections page!');
    return;
  }
  
  const connections = await extractConnectionsList();
  
  if (connections.length === 0) {
    logError('No connections found!');
    return;
  }
  
  // Send to Telegram
  chrome.runtime.sendMessage({
    type: 'SEND_TO_TELEGRAM',
    connections: connections
  });
  
  chrome.runtime.sendMessage({
    type: 'EXTRACTION_COMPLETE',
    count: connections.length,
    connections: connections
  });
}

async function startFullScrape() {
  log('Starting full scrape...');
  
  if (!window.location.href.includes('linkedin.com/mynetwork/invite-connect/connections')) {
    logError('Not on connections page!');
    return;
  }
  
  const connections = await extractConnectionsList();
  
  if (connections.length === 0) {
    logError('No connections found!');
    return;
  }
  
  log(`Found ${connections.length} connections. Starting profile scraping...`);
  await saveProgress(connections, 0);
  await sleep(2000);
  await scrapeProfile(connections[0], 0, connections.length);
}

async function resumeScrape() {
  log('Resuming scrape...');
  const progress = await loadProgress();
  
  if (!progress) {
    log('No scrape to resume');
    return;
  }
  
  const { connections, index } = progress;
  log(`Resuming from ${index + 1}/${connections.length}`);
  await scrapeProfile(connections[index], index, connections.length);
}

// ============================================
// Message Listener
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'START_EXTRACTION':
      startListExtraction();
      break;
    case 'START_FULL_SCRAPE':
      startFullScrape();
      break;
    case 'RESUME_SCRAPE':
      resumeScrape();
      break;
    case 'STOP_SCRAPE':
      clearProgress();
      log('Scraping stopped');
      break;
  }
  sendResponse({ status: 'ok' });
  return true;
});

// ============================================
// Auto-Initialize
// ============================================
(async function init() {
  log('Content script loaded on: ' + window.location.href);
  await sleep(2000);
  
  // If on profile page, check if we should continue scraping
  if (window.location.href.includes('/in/')) {
    const progress = await loadProgress();
    if (progress) {
      log('Detected scraping in progress...');
      await continueProfileScraping();
    }
  }
})();
