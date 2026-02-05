/**
 * content.js - LinkedIn Scraper (CLEAN REWRITE)
 * Simple, reliable scraping without over-engineering
 */

// ============================================
// Prevent Multiple Instances
// ============================================
if (window.lumenRunning) {
  console.log('[Lumen] Already running, stopping duplicate');
  // Don't just throw, actually stop execution
  (function() { return; })();
}
window.lumenRunning = true;
console.log('[Lumen] Instance started');

// ============================================
// Simple Configuration
// ============================================
const CONFIG = {
  SCROLL_DELAY: 4000, // Wait 4s for LinkedIn to load more
  PROFILE_DELAY: 75000, // 75 seconds between profiles
  PAGE_WAIT: 4000,
  MODAL_WAIT: 3000,
  MAX_RETRIES: 2,
  MAX_NO_CHANGE: 5, // Allow 5 scrolls with no new content before stopping
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
  let previousHeight = 0;
  
  // Find the scrollable container (LinkedIn uses a specific container)
  const scrollContainer = document.querySelector('.scaffold-finite-scroll__content') || 
                          document.querySelector('main') || 
                          window;
  
  while (scrolls < 150 && noChangeCount < CONFIG.MAX_NO_CHANGE) {
    scrolls++;
    
    // Extract connections from current view
    const startCount = connections.size;
    
    // Find all profile links in the main content area
    const links = document.querySelectorAll('a[href*="/in/"]');
    
    links.forEach(link => {
      // Only process links that are in the connections list (not header/footer)
      const isInMainContent = link.closest('main') !== null;
      if (!isInMainContent) return;
      
      const url = link.href.split('?')[0].replace(/\/$/, '');
      if (!url.includes('/in/')) return;
      
      // Skip if already have this connection
      if (connections.has(url)) return;
      
      // Extract name and description separately
      let name = '';
      let description = '';
      
      // LinkedIn structure: usually has multiple spans
      // First span[aria-hidden] is the name
      // Second span or nearby element has the headline/description
      const allSpans = link.querySelectorAll('span[aria-hidden="true"]');
      
      if (allSpans.length >= 1) {
        // First span is usually the name
        name = allSpans[0].textContent.trim();
        
        // If there are more spans, second one might be description
        if (allSpans.length >= 2) {
          description = allSpans[1].textContent.trim();
        }
      } else {
        // Fallback: try to split the text content
        const fullText = link.textContent.trim();
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length >= 1) name = lines[0];
        if (lines.length >= 2) description = lines[1];
      }
      
      // If still no description, try to find it in parent container
      if (!description) {
        const container = link.closest('li') || link.closest('[class*="card"]');
        if (container) {
          // Look for spans that aren't the name
          const spans = container.querySelectorAll('span');
          for (const span of spans) {
            const text = span.textContent.trim();
            if (text && text !== name && text.length > 10 && text.length < 200) {
              description = text;
              break;
            }
          }
        }
      }
      
      // Clean up name
      name = name.replace(/^View\s+/i, '').replace(/['']s profile$/i, '').trim();
      
      // Clean up description - remove common noise
      description = description.replace(/^View\s+/i, '').replace(/['']s profile$/i, '').trim();
      
      // Validate name
      if (name && name.length > 2 && !name.toLowerCase().includes('message')) {
        connections.set(url, { 
          name, 
          description: description || '',
          profileUrl: url, 
          email: null, 
          phone: null 
        });
      }
    });
    
    const newCount = connections.size - startCount;
    
    if (newCount > 0) {
      log(`Scroll #${scrolls}: Found ${newCount} new (${connections.size} total)`);
      noChangeCount = 0; // Reset counter when we find new ones
    } else {
      noChangeCount++;
      log(`Scroll #${scrolls}: No new connections (${noChangeCount}/${CONFIG.MAX_NO_CHANGE})`);
    }
    
    // Check if page height changed
    const currentHeight = document.documentElement.scrollHeight;
    if (currentHeight === previousHeight) {
      log('  Page height unchanged');
    } else {
      log(`  Page grew: ${previousHeight} → ${currentHeight}`);
      previousHeight = currentHeight;
    }
    
    // Stop if we've reached the end
    if (noChangeCount >= CONFIG.MAX_NO_CHANGE) {
      log('Reached end of connections list');
      break;
    }
    
    // Scroll down aggressively
    if (scrollContainer === window) {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'smooth'
      });
    } else {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
    
    // Also scroll the window just in case
    window.scrollBy({ top: 1000, behavior: 'smooth' });
    
    // Wait longer for LinkedIn to load more content
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
    log(`  Found email in mailto link: ${email}`);
  }
  
  // If no mailto link, search for email pattern in text
  if (!email) {
    const bodyText = document.body.innerText;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emailMatches = bodyText.match(emailRegex);
    if (emailMatches && emailMatches.length > 0) {
      email = emailMatches[0];
      log(`  Found email in text: ${email}`);
    }
  }
  
  // Extract phone
  let phone = null;
  
  // First try tel: link
  const telLink = document.querySelector('a[href^="tel:"]');
  if (telLink) {
    phone = telLink.textContent.trim();
    log(`  Found phone in tel link: ${phone}`);
  }
  
  // If no tel: link, search for phone patterns in the page
  if (!phone) {
    log('  Searching for phone in text...');
    const bodyText = document.body.innerText;
    
    // Look for "Phone" section and extract number after it
    const phoneLines = bodyText.split('\n');
    for (let i = 0; i < phoneLines.length; i++) {
      const line = phoneLines[i].trim();
      
      // If we find a line that says "Phone", check the next few lines
      if (line.toLowerCase() === 'phone') {
        for (let j = i + 1; j < Math.min(i + 3, phoneLines.length); j++) {
          const nextLine = phoneLines[j].trim();
          // Match phone patterns like: +91-7798950524, (123) 456-7890, +1 234 567 8900
          const phoneRegex = /[\+\(]?[0-9][\d\s\(\)\-\.]{7,}[0-9]/;
          if (phoneRegex.test(nextLine)) {
            phone = nextLine.split('(')[0].trim(); // Remove labels like "(Home)"
            log(`  Found phone after "Phone" label: ${phone}`);
            break;
          }
        }
        if (phone) break;
      }
    }
  }
  
  // Last resort: find any phone-like pattern in the entire page
  if (!phone) {
    const bodyText = document.body.innerText;
    // Match international phone numbers: +91-1234567890, +1 (123) 456-7890, etc.
    const phoneRegex = /\+\d{1,4}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{4,}/;
    const match = bodyText.match(phoneRegex);
    if (match) {
      phone = match[0];
      log(`  Found phone pattern: ${phone}`);
    }
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
      description: conn.description,
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
  if (!window.lumenRunning) {
    console.log('[Lumen] Not initialized, ignoring message');
    return;
  }
  
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
