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
  PROFILE_DELAY: 10, // 75 seconds between profiles
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

// Log to popup only (not Telegram)
function log(msg) {
  console.log(`[Lumen] ${msg}`);
  chrome.runtime.sendMessage({ type: 'STATUS', text: msg });
}

// Log errors to popup
function logError(msg) {
  console.error(`[Lumen] ${msg}`);
  chrome.runtime.sendMessage({ type: 'STATUS', text: msg, level: 'error' });
}

// Send important events to Telegram (start, complete, errors)
function notifyTelegram(msg) {
  chrome.runtime.sendMessage({ type: 'TELEGRAM_NOTIFY', text: msg });
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
// Contact Database Functions
// ============================================
function extractUsername(profileUrl) {
  // Extract username from URL: linkedin.com/in/john-smith-123 → john-smith-123
  const match = profileUrl.match(/\/in\/([^\/\?]+)/);
  return match ? match[1].toLowerCase() : null;
}

async function getContactsDB() {
  const data = await chrome.storage.local.get('lumen_contacts_db');
  return data.lumen_contacts_db || {};
}

async function saveContactToDB(contact) {
  const username = extractUsername(contact.profileUrl);
  if (!username) return false;
  
  const db = await getContactsDB();
  db[username] = {
    name: contact.name,
    description: contact.description || '',
    company: contact.company || '',
    profileUrl: contact.profileUrl,
    email: contact.email || null,
    phone: contact.phone || null,
    scrapedAt: Date.now()
  };
  
  await chrome.storage.local.set({ lumen_contacts_db: db });
  log(`💾 Saved to DB: ${contact.name} (${Object.keys(db).length} total)`);
  return true;
}

async function isAlreadyScraped(profileUrl) {
  const username = extractUsername(profileUrl);
  if (!username) return false;
  
  const db = await getContactsDB();
  return db.hasOwnProperty(username);
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
      
      // LinkedIn connection cards have:
      // - Name in the link itself (visible text, not aria-hidden)
      // - Description/occupation in a separate span outside the link
      
      // Get the parent container first
      const container = link.closest('li') || link.closest('[class*="card"]') || link.parentElement?.parentElement;
      
      // Method 1: Find name from visible span (not aria-hidden) inside link
      const visibleSpans = link.querySelectorAll('span:not([aria-hidden])');
      for (const span of visibleSpans) {
        const text = span.textContent.trim();
        if (text && text.length > 2 && text.length < 100) {
          name = text;
          break;
        }
      }
      
      // Method 2: If no visible span, try first line of link text
      if (!name) {
        const linkText = link.textContent.trim();
        // Split by newlines and take first non-empty line
        const lines = linkText.split('\n').map(l => l.trim()).filter(l => l && l.length > 2);
        if (lines.length > 0) {
          name = lines[0];
        }
      }
      
      // Now find description and company in container (outside the name link)
      let company = '';
      
      if (container) {
        // Look for occupation/headline spans with specific classes
        const occupationSelectors = [
          'span[class*="occupation"]',
          'span[class*="headline"]', 
          'span[class*="subtitle"]',
          '.mn-connection-card__occupation',
          '.t-14.t-black--light.t-normal'
        ];
        
        for (const selector of occupationSelectors) {
          const el = container.querySelector(selector);
          if (el) {
            description = el.textContent.trim();
            break;
          }
        }
        
        // Look for company name - usually in a separate element
        const companySelectors = [
          'span[class*="company"]',
          'span[class*="organization"]',
          '.mn-connection-card__company',
          '.entity-result__primary-subtitle',
          'span.t-black--light'
        ];
        
        for (const selector of companySelectors) {
          const el = container.querySelector(selector);
          if (el) {
            const text = el.textContent.trim();
            // Make sure it's not the same as description
            if (text && text !== description) {
              company = text;
              break;
            }
          }
        }
        
        // Fallback: find secondary spans that aren't name or description
        if (!company) {
          const allContainerSpans = container.querySelectorAll('span');
          let foundDescription = false;
          for (const span of allContainerSpans) {
            if (link.contains(span)) continue;
            
            const text = span.textContent.trim();
            if (!text || text.length < 3 || text.length > 200) continue;
            if (text === name || name.includes(text)) continue;
            if (text.includes('View') && text.includes('profile')) continue;
            if (text.toLowerCase() === 'message') continue;
            if (text.match(/^\d+\s*(mutual|connections)/i)) continue;
            if (text.match(/^Connected\s/i)) continue;
            
            // First valid span is description, second is company
            if (!foundDescription && !description) {
              description = text;
              foundDescription = true;
            } else if (foundDescription && text !== description) {
              company = text;
              break;
            }
          }
        }
      }
      
      // Clean up name - remove any description that got concatenated
      if (description && name.includes(description)) {
        name = name.replace(description, '').trim();
      }
      
      // Clean up name
      name = name.replace(/^View\s+/i, '').replace(/['']s profile$/i, '').trim();
      
      // Clean up description - remove common noise
      description = description.replace(/^View\s+/i, '').replace(/['']s profile$/i, '').trim();
      
      // Clean up company
      company = company.replace(/^View\s+/i, '').replace(/['']s profile$/i, '').trim();
      
      // Validate name
      if (name && name.length > 2 && !name.toLowerCase().includes('message')) {
        connections.set(url, { 
          name, 
          description: description || '',
          company: company || '',
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

async function extractExperience() {
  log('Extracting experience...');
  
  let experienceSection = document.getElementById('experience');
  
  // Fallback: Find by header text if ID is missing
  if (!experienceSection) {
    const headers = Array.from(document.querySelectorAll('h2, h3, span'));
    for (const h of headers) {
      if (h.innerText.trim() === 'Experience') {
        experienceSection = h.closest('section') || h.closest('div.pvs-list__outer-container') || h.parentElement;
        log('  Found experience section by text header');
        break;
      }
    }
  }
  
  if (!experienceSection) {
    log('  No experience section found');
    return null;
  }
  
  // Strategy: Strict Logo Aria-Label Only
  // Selector: a[href*="/company/"] -> figure[aria-label]
  // We take the first one found in the section
  const firstCompanyLogo = experienceSection.querySelector('a[href*="/company/"] figure[aria-label]');
  
  if (firstCompanyLogo) {
    const ariaLabel = firstCompanyLogo.getAttribute('aria-label');
    if (ariaLabel) {
      // Remove " logo" from end if exists (case insensitive)
      const companyName = ariaLabel.replace(/\s+logo$/i, '').trim();
      log(`  Match via logo aria-label: ${companyName}`);
      return companyName;
    }
  }
  
  log('  No company logo with aria-label found (strict mode)');
  return null;
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
  
  // Extract experience/company
  const company = await extractExperience();
  
  conn.email = email;
  conn.phone = phone;
  if (company) {
    conn.company = company; // Update with more reliable company name from profile
  }
  conn.scraped = true;
  
  // Save to persistent database
  await saveContactToDB(conn);
  
  // Notify popup of progress (no Telegram for contact data)
  const emailIcon = email ? '📧' : '';
  const phoneIcon = phone ? '📱' : '';
  chrome.runtime.sendMessage({
    type: 'CONTACT_SCRAPED',
    name: conn.name,
    hasEmail: !!email,
    hasPhone: !!phone,
    index: index + 1,
    total: connections.length
  });
  
  // Move to next - skip already scraped
  let nextIndex = index + 1;
  let skipped = 0;
  
  while (nextIndex < connections.length) {
    const alreadyDone = await isAlreadyScraped(connections[nextIndex].profileUrl);
    if (!alreadyDone) break;
    log(`⏭️ Skipping ${connections[nextIndex].name} (already in database)`);
    skipped++;
    nextIndex++;
  }
  
  if (skipped > 0) {
    log(`Skipped ${skipped} already-scraped profiles`);
  }
  
  if (nextIndex < connections.length) {
    await saveProgress(connections, nextIndex);
    log(`Waiting ${CONFIG.PROFILE_DELAY / 1000}s before next profile...`);
    await sleep(CONFIG.PROFILE_DELAY);
    await scrapeProfile(connections[nextIndex], nextIndex, connections.length);
  } else {
    // Done!
    log('All profiles scraped!');
    notifyTelegram(`✅ Scraping complete! ${connections.length} profiles processed.`);
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
  
  // Notify popup (no Telegram for data - only observability)
  chrome.runtime.sendMessage({
    type: 'EXTRACTION_COMPLETE',
    count: connections.length,
    connections: connections
  });
}

async function startFullScrape() {
  log('Starting full scrape...');
  notifyTelegram('🚀 Starting full scrape...');
  
  if (!window.location.href.includes('linkedin.com/mynetwork/invite-connect/connections')) {
    logError('Not on connections page!');
    notifyTelegram('❌ Error: Not on connections page');
    return;
  }
  
  const connections = await extractConnectionsList();
  
  if (connections.length === 0) {
    logError('No connections found!');
    notifyTelegram('❌ Error: No connections found on page');
    return;
  }
  
  // Filter out already scraped connections
  let startIndex = 0;
  let skipped = 0;
  
  for (let i = 0; i < connections.length; i++) {
    const alreadyDone = await isAlreadyScraped(connections[i].profileUrl);
    if (!alreadyDone) {
      startIndex = i;
      break;
    }
    skipped++;
    if (i === connections.length - 1) {
      startIndex = connections.length; // All done
    }
  }
  
  if (skipped > 0) {
    log(`⏭️ Skipping ${skipped} already-scraped profiles`);
  }
  
  if (startIndex >= connections.length) {
    log('✅ All connections already scraped!');
    notifyTelegram('✅ All connections already in database!');
    chrome.runtime.sendMessage({
      type: 'SCRAPING_COMPLETE',
      connections: connections,
      failedProfiles: []
    });
    return;
  }
  
  const toScrape = connections.length - startIndex;
  log(`Found ${connections.length} connections. Starting from #${startIndex + 1}...`);
  notifyTelegram(`📊 Found ${connections.length} connections, ${toScrape} to scrape (${skipped} already done)`);
  await saveProgress(connections, startIndex);
  await sleep(2000);
  await scrapeProfile(connections[startIndex], startIndex, connections.length);
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
