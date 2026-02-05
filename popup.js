/**
 * popup.js - Handles popup UI interactions
 * 
 * Responsibilities:
 * - Save/load Telegram config to chrome.storage.local
 * - Send start message to content script
 * - Display status updates from content script
 */

const statusDiv = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const fullScrapeBtn = document.getElementById('fullScrapeBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');
const saveConfigBtn = document.getElementById('saveConfig');
const testTelegramBtn = document.getElementById('testTelegram');
const checkQueueBtn = document.getElementById('checkQueue');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const botTokenInput = document.getElementById('botToken');
const chatIdInput = document.getElementById('chatId');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const etaText = document.getElementById('etaText');

let lastExtractedConnections = null;
let scrapeStartTime = null;

// ============================================
// Status Display
// ============================================

function addStatus(message, type = '') {
  const line = document.createElement('div');
  line.className = `status-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  statusDiv.appendChild(line);
  statusDiv.scrollTop = statusDiv.scrollHeight;
}

function clearStatus() {
  statusDiv.innerHTML = '';
}

// ============================================
// Config Management
// ============================================

async function loadConfig() {
  const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
  if (config.telegramBotToken) {
    botTokenInput.value = config.telegramBotToken;
  }
  if (config.telegramChatId) {
    chatIdInput.value = config.telegramChatId;
  }
  
  // Check for active scraping session
  const progress = await chrome.storage.local.get(['lumen_connections', 'lumen_current_index']);
  if (progress.lumen_connections && progress.lumen_current_index !== undefined) {
    const remaining = progress.lumen_connections.length - progress.lumen_current_index;
    addStatus(`⏸️ Paused session: ${remaining} profiles remaining`, 'info');
    addStatus('Click "Resume" to continue or "Stop" to cancel', 'info');
    resumeBtn.style.display = 'block';
    
    // Show progress if in scraping mode
    if (progress.lumen_current_index > 0) {
      updateProgress(progress.lumen_current_index, progress.lumen_connections.length);
    }
  }
  
  // Check for last extracted connections
  const lastData = await chrome.storage.local.get('lumen_last_extraction');
  if (lastData.lumen_last_extraction) {
    lastExtractedConnections = lastData.lumen_last_extraction;
    exportCsvBtn.style.display = 'block';
  }
}

function exportToCSV() {
  if (!lastExtractedConnections || lastExtractedConnections.length === 0) {
    addStatus('No data to export', 'error');
    return;
  }
  
  // Build CSV content
  const headers = ['Name', 'Profile URL', 'Email', 'Phone', 'Scraped'];
  const rows = lastExtractedConnections.map(conn => [
    conn.name || '',
    conn.profileUrl || '',
    conn.email || '',
    conn.phone || '',
    conn.scraped ? 'Yes' : 'No'
  ]);
  
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');
  
  // Download file
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linkedin-connections-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  
  addStatus(`📥 Exported ${lastExtractedConnections.length} connections to CSV`, 'success');
}

async function saveConfig() {
  const botToken = botTokenInput.value.trim();
  const chatId = chatIdInput.value.trim();
  
  if (!botToken || !chatId) {
    addStatus('Please enter both Bot Token and Chat ID', 'error');
    return;
  }
  
  await chrome.storage.local.set({
    telegramBotToken: botToken,
    telegramChatId: chatId
  });
  
  addStatus('Config saved!', 'success');
}

async function testTelegram() {
  const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
  
  if (!config.telegramBotToken || !config.telegramChatId) {
    addStatus('Please save config first', 'error');
    return;
  }
  
  testTelegramBtn.disabled = true;
  testTelegramBtn.textContent = 'Testing...';
  addStatus('Testing Telegram connection...', 'info');
  
  chrome.runtime.sendMessage({ type: 'TEST_TELEGRAM' }, (response) => {
    testTelegramBtn.disabled = false;
    testTelegramBtn.textContent = 'Test Connection';
    
    if (response && response.success) {
      addStatus('✅ Telegram connected successfully!', 'success');
    } else {
      addStatus(`❌ Connection failed: ${response?.error || 'Unknown error'}`, 'error');
    }
  });
}

async function checkQueue() {
  chrome.runtime.sendMessage({ type: 'CHECK_QUEUE' }, (response) => {
    if (response) {
      addStatus(`📊 Queue: ${response.queueLength} messages pending`, 'info');
      addStatus(`Processing: ${response.isProcessing ? 'Yes' : 'No'}`, 'info');
      if (response.queueLength > 0) {
        addStatus('Messages will auto-retry every 30s', 'info');
      }
    }
  });
}

// ============================================
// Check Tab and Config
// ============================================

async function validateAndGetTab() {
  const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
  
  if (!config.telegramBotToken || !config.telegramChatId) {
    addStatus('Please save Telegram config first', 'error');
    return null;
  }
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab) {
    addStatus('No active tab found', 'error');
    return null;
  }
  
  return tab;
}

// ============================================
// Start List Extraction Only
// ============================================

async function startExtraction() {
  const tab = await validateAndGetTab();
  if (!tab) return;
  
  // Check if we're on LinkedIn at all
  if (!tab.url.includes('linkedin.com')) {
    addStatus('Opening LinkedIn Connections page...', 'info');
    await chrome.tabs.update(tab.id, { 
      url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/' 
    });
    await sleep(4000); // Extra time for LinkedIn to load
  }
  
  setButtonsDisabled(true);
  clearStatus();
  addStatus('Starting list extraction...', 'info');
  
  // Navigate to connections page if not already there
  if (!tab.url.includes('linkedin.com/mynetwork/invite-connect/connections')) {
    addStatus('Navigating to Connections page...', 'info');
    await chrome.tabs.update(tab.id, { 
      url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/' 
    });
    
    // Wait for page to load, then start extraction
    await sleep(3000);
  }
  
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'START_EXTRACTION' });
  } catch (err) {
    addStatus('Failed to connect. Try refreshing LinkedIn.', 'error');
    setButtonsDisabled(false);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Start Full Scrape (List + Profiles)
// ============================================

async function startFullScrape() {
  const tab = await validateAndGetTab();
  if (!tab) return;
  
  // Check if we're on LinkedIn at all
  if (!tab.url.includes('linkedin.com')) {
    addStatus('Opening LinkedIn Connections page...', 'info');
    await chrome.tabs.update(tab.id, { 
      url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/' 
    });
    await sleep(4000); // Extra time for LinkedIn to load
  }
  
  setButtonsDisabled(true);
  clearStatus();
  addStatus('Starting full scrape (list + profiles)...', 'info');
  addStatus('⚠️ This will take a long time (~1 min per profile)', 'info');
  
  // Navigate to connections page if not already there
  if (!tab.url.includes('linkedin.com/mynetwork/invite-connect/connections')) {
    addStatus('Navigating to Connections page...', 'info');
    await chrome.tabs.update(tab.id, { 
      url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/' 
    });
    
    // Wait for page to load, then start extraction
    await sleep(5000);
  }
  
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'START_FULL_SCRAPE' });
  } catch (err) {
    addStatus('Failed to connect. Try refreshing LinkedIn.', 'error');
    setButtonsDisabled(false);
  }
}

// ============================================
// Resume Scraping
// ============================================

async function resumeScrape() {
  const tab = await validateAndGetTab();
  if (!tab) return;
  
  setButtonsDisabled(true);
  clearStatus();
  addStatus('Resuming profile scraping...', 'info');
  
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'RESUME_SCRAPE' });
  } catch (err) {
    addStatus('Failed to connect. Try refreshing the page.', 'error');
    setButtonsDisabled(false);
  }
}

// ============================================
// Stop Scraping
// ============================================

async function stopScrape() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'STOP_SCRAPE' });
    addStatus('Scraping stopped', 'info');
  } catch (err) {
    // Content script might not be running
  }
  
  // Clear progress
  await chrome.storage.local.remove([
    'lumen_connections',
    'lumen_current_index',
    'lumen_timestamp'
  ]);
  
  setButtonsDisabled(false);
  resumeBtn.style.display = 'none';
  addStatus('Session cleared', 'success');
}

// ============================================
// UI Helpers
// ============================================

function updateProgress(current, total) {
  if (total === 0) {
    progressSection.style.display = 'none';
    return;
  }
  
  progressSection.style.display = 'block';
  const percent = Math.round((current / total) * 100);
  progressBar.style.width = percent + '%';
  progressText.textContent = `${current} / ${total} (${percent}%)`;
  
  // Calculate ETA
  if (scrapeStartTime && current > 0) {
    const elapsed = Date.now() - scrapeStartTime;
    const avgTime = elapsed / current;
    const remaining = total - current;
    const etaMs = avgTime * remaining;
    const etaMins = Math.round(etaMs / 60000);
    etaText.textContent = etaMins > 0 ? `ETA: ${etaMins} min` : 'ETA: <1 min';
  } else {
    etaText.textContent = 'ETA: calculating...';
  }
}

function setButtonsDisabled(disabled) {
  startBtn.disabled = disabled;
  fullScrapeBtn.disabled = disabled;
  resumeBtn.disabled = disabled;
  
  if (disabled) {
    startBtn.textContent = '⏳ Running...';
    fullScrapeBtn.textContent = '⏳ Running...';
    scrapeStartTime = Date.now();
  } else {
    startBtn.textContent = '🚀 Quick Extract (Names Only)';
    fullScrapeBtn.textContent = '🔍 Full Scrape (With Contact Info)';
    scrapeStartTime = null;
  }
}

// ============================================
// Message Listener (from content script / background)
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'STATUS':
      addStatus(message.text, message.level || '');
      break;
      
    case 'EXTRACTION_COMPLETE':
      addStatus(`List extracted: ${message.count} connections`, 'success');
      if (message.connections) {
        lastExtractedConnections = message.connections;
        chrome.storage.local.set({ lumen_last_extraction: message.connections });
        exportCsvBtn.style.display = 'block';
      }
      setButtonsDisabled(false);
      updateProgress(0, 0);
      break;
      
    case 'EXTRACTION_ERROR':
      const errorMsg = getFriendlyErrorMessage(message.error);
      addStatus(errorMsg, 'error');
      setButtonsDisabled(false);
      updateProgress(0, 0);
      break;
      
    case 'TELEGRAM_SENT':
      addStatus(`Sent batch ${message.batch}/${message.total}`, 'success');
      break;
      
    case 'CONTACT_SENT':
      const emailIcon = message.hasEmail ? '📧' : '';
      const phoneIcon = message.hasPhone ? '📱' : '';
      addStatus(`[${message.index}/${message.total}] ${message.name} ${emailIcon}${phoneIcon}`, 'success');
      updateProgress(message.index, message.total);
      break;
      
    case 'TELEGRAM_ERROR':
      addStatus(`Telegram error: ${message.error}`, 'error');
      break;
      
    case 'SCRAPING_COMPLETE':
      if (message.failed > 0) {
        addStatus(`🎉 Done! ${message.total} scraped, ${message.failed} failed`, 'success');
      } else {
        addStatus('🎉 All profiles scraped!', 'success');
      }
      setButtonsDisabled(false);
      resumeBtn.style.display = 'none';
      updateProgress(0, 0);
      break;
      
    case 'SCRAPE_PAUSED':
      const pauseMsg = getFriendlyErrorMessage(message.reason, message.message);
      addStatus(`⚠️ PAUSED: ${pauseMsg}`, 'error');
      addStatus('Fix the issue, then click Resume', 'info');
      setButtonsDisabled(false);
      resumeBtn.style.display = 'block';
      break;
  }
});

function getFriendlyErrorMessage(errorType, details) {
  const errorMessages = {
    'LOGGED_OUT': '🔒 Session expired - Please log back into LinkedIn in this tab',
    'CAPTCHA': '🤖 LinkedIn security check detected - Solve the puzzle, then click Resume',
    'SELECTOR_FAILED': '🔍 Can\'t find connections - Try refreshing the page and running again',
    'PAGE_LOAD_FAILED': '⏳ Page took too long to load - Check your connection and try again',
    'NETWORK_ERROR': '📡 Network issue - Check your internet connection',
    'No connections found': '👥 No connections found - Make sure you\'re on the Connections page and logged in'
  };
  
  return errorMessages[errorType] || errorMessages[details] || details || errorType || 'Unknown error occurred';
}

// ============================================
// Event Listeners
// ============================================

saveConfigBtn.addEventListener('click', saveConfig);
testTelegramBtn.addEventListener('click', testTelegram);
checkQueueBtn.addEventListener('click', checkQueue);
startBtn.addEventListener('click', startExtraction);
fullScrapeBtn.addEventListener('click', startFullScrape);
resumeBtn.addEventListener('click', resumeScrape);
stopBtn.addEventListener('click', stopScrape);
exportCsvBtn.addEventListener('click', exportToCSV);

// Load config on popup open
loadConfig();
