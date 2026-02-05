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
const botTokenInput = document.getElementById('botToken');
const chatIdInput = document.getElementById('chatId');

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
    resumeBtn.style.display = 'block';
  }
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
  
  if (!tab.url.includes('linkedin.com/mynetwork/invite-connect/connections')) {
    addStatus('Please navigate to LinkedIn Connections page first', 'error');
    addStatus('URL: linkedin.com/mynetwork/invite-connect/connections', 'info');
    return;
  }
  
  setButtonsDisabled(true);
  clearStatus();
  addStatus('Starting list extraction...', 'info');
  
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'START_EXTRACTION' });
  } catch (err) {
    addStatus('Failed to connect. Try refreshing LinkedIn.', 'error');
    setButtonsDisabled(false);
  }
}

// ============================================
// Start Full Scrape (List + Profiles)
// ============================================

async function startFullScrape() {
  const tab = await validateAndGetTab();
  if (!tab) return;
  
  if (!tab.url.includes('linkedin.com/mynetwork/invite-connect/connections')) {
    addStatus('Please navigate to LinkedIn Connections page first', 'error');
    return;
  }
  
  setButtonsDisabled(true);
  clearStatus();
  addStatus('Starting full scrape (list + profiles)...', 'info');
  addStatus('⚠️ This will take a long time (~1 min per profile)', 'info');
  
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

function setButtonsDisabled(disabled) {
  startBtn.disabled = disabled;
  fullScrapeBtn.disabled = disabled;
  resumeBtn.disabled = disabled;
  
  if (disabled) {
    startBtn.textContent = 'Running...';
    fullScrapeBtn.textContent = 'Running...';
  } else {
    startBtn.textContent = 'Extract List Only';
    fullScrapeBtn.textContent = 'Full Scrape (List + Profiles)';
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
      setButtonsDisabled(false);
      break;
      
    case 'EXTRACTION_ERROR':
      addStatus(`Error: ${message.error}`, 'error');
      setButtonsDisabled(false);
      break;
      
    case 'TELEGRAM_SENT':
      addStatus(`Sent batch ${message.batch}/${message.total}`, 'success');
      break;
      
    case 'CONTACT_SENT':
      const emailIcon = message.hasEmail ? '📧' : '';
      const phoneIcon = message.hasPhone ? '📱' : '';
      addStatus(`[${message.index}/${message.total}] ${message.name} ${emailIcon}${phoneIcon}`, 'success');
      break;
      
    case 'TELEGRAM_ERROR':
      addStatus(`Telegram error: ${message.error}`, 'error');
      break;
      
    case 'SCRAPING_COMPLETE':
      addStatus('🎉 All profiles scraped!', 'success');
      setButtonsDisabled(false);
      resumeBtn.style.display = 'none';
      break;
  }
});

// ============================================
// Event Listeners
// ============================================

saveConfigBtn.addEventListener('click', saveConfig);
startBtn.addEventListener('click', startExtraction);
fullScrapeBtn.addEventListener('click', startFullScrape);
resumeBtn.addEventListener('click', resumeScrape);
stopBtn.addEventListener('click', stopScrape);

// Load config on popup open
loadConfig();
