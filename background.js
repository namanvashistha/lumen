/**
 * background.js - Service Worker for Telegram API communication
 * 
 * Responsibilities:
 * - Receive extracted connections from content script
 * - Batch connections list into Telegram-safe messages (<4096 chars)
 * - Send individual contact info messages
 * - Send to Telegram Bot API with retry logic
 * 
 * This is the ONLY place that makes external network calls.
 */

// ============================================
// Configuration
// ============================================

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_MESSAGE_LENGTH = 4000;
const BATCH_DELAY = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const OFFLINE_RETRY_INTERVAL = 30000; // 30 seconds
const MAX_OFFLINE_RETRIES = 60; // 30 minutes total

// Message queue for offline resilience
let messageQueue = [];
let isProcessingQueue = false;

// ============================================
// Telegram API with Retry Logic
// ============================================

async function queueMessage(botToken, chatId, text) {
  messageQueue.push({
    botToken,
    chatId,
    text,
    attempts: 0,
    timestamp: Date.now(),
  });
  
  await chrome.storage.local.set({ lumen_message_queue: messageQueue });
  
  if (!isProcessingQueue) {
    processMessageQueue();
  }
}

async function loadMessageQueue() {
  const data = await chrome.storage.local.get('lumen_message_queue');
  if (data.lumen_message_queue) {
    messageQueue = data.lumen_message_queue;
    if (messageQueue.length > 0) {
      console.log(`[Lumen] Loaded ${messageQueue.length} queued messages`);
      processMessageQueue();
    }
  }
}

async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (messageQueue.length > 0) {
    const message = messageQueue[0];
    
    try {
      await sendTelegramMessage(message.botToken, message.chatId, message.text, 1);
      messageQueue.shift(); // Remove successful message
      await chrome.storage.local.set({ lumen_message_queue: messageQueue });
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    } catch (err) {
      message.attempts++;
      
      if (message.attempts >= MAX_OFFLINE_RETRIES) {
        console.error('[Lumen] Message failed after max retries, discarding:', err);
        messageQueue.shift();
        await chrome.storage.local.set({ lumen_message_queue: messageQueue });
      } else {
        console.log(`[Lumen] Message failed, will retry (${message.attempts}/${MAX_OFFLINE_RETRIES})`);
        notifyPopup('STATUS', { 
          text: `Offline mode - ${messageQueue.length} messages queued`, 
          level: 'info' 
        });
        break; // Stop processing, will retry later
      }
    }
  }
  
  isProcessingQueue = false;
  
  // If queue still has messages, retry after interval
  if (messageQueue.length > 0) {
    setTimeout(() => processMessageQueue(), OFFLINE_RETRY_INTERVAL);
  }
}

async function sendTelegramMessage(botToken, chatId, text, retries = MAX_RETRIES) {
  const url = `${TELEGRAM_API_BASE}${botToken}/sendMessage`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.description || 'Telegram API error');
      }
      
      return response.json();
      
    } catch (err) {
      console.warn(`[Lumen] Telegram attempt ${attempt}/${retries} failed:`, err.message);
      
      if (attempt === retries) {
        throw err; // Last attempt, rethrow
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }
}

// ============================================
// Batching Logic (for connections list)
// ============================================

function batchConnections(connections) {
  const batches = [];
  let currentBatch = [];
  let currentLength = 0;
  
  const header = '🔗 <b>LinkedIn Connections List</b>\n\n';
  
  for (const conn of connections) {
    const line = `${escapeHtml(conn.name)}\n${conn.profileUrl}\n\n`;
    const lineLength = line.length;
    
    if (currentLength + lineLength > MAX_MESSAGE_LENGTH) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch.join(''));
        currentBatch = [];
        currentLength = 0;
      }
    }
    
    currentBatch.push(line);
    currentLength += lineLength;
  }
  
  if (currentBatch.length > 0) {
    batches.push(currentBatch.join(''));
  }
  
  if (batches.length > 0) {
    batches[0] = header + batches[0];
  }
  
  return batches;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================
// Format Individual Contact Message
// ============================================

function formatContactMessage(contact) {
  let msg = `📇 <b>Contact ${contact.index}/${contact.total}</b>\n\n`;
  msg += `<b>Name:</b> ${escapeHtml(contact.name)}\n`;
  msg += `<b>Profile:</b> ${contact.profileUrl}\n`;
  
  if (contact.email) {
    msg += `<b>Email:</b> ${escapeHtml(contact.email)}\n`;
  }
  
  if (contact.phone) {
    msg += `<b>Phone:</b> ${escapeHtml(contact.phone)}\n`;
  }
  
  if (!contact.email && !contact.phone) {
    msg += `\n<i>No contact info available</i>`;
  }
  
  return msg;
}

// ============================================
// Send Functions
// ============================================

async function sendConnectionsToTelegram(connections) {
  try {
    const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
    
    if (!config.telegramBotToken || !config.telegramChatId) {
      notifyPopup('TELEGRAM_ERROR', { error: 'Telegram config not set' });
      return;
    }
    
    const batches = batchConnections(connections);
    console.log(`[Lumen] Sending ${batches.length} batches to Telegram`);
    
    for (let i = 0; i < batches.length; i++) {
      const batchNum = i + 1;
      
      try {
        await queueMessage(
          config.telegramBotToken,
          config.telegramChatId,
          batches[i]
        );
        
        notifyPopup('TELEGRAM_SENT', { batch: batchNum, total: batches.length });
        console.log(`[Lumen] Sent batch ${batchNum}/${batches.length}`);
        
        if (i < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
        
      } catch (err) {
        console.error(`[Lumen] Failed to send batch ${batchNum}:`, err);
        notifyPopup('TELEGRAM_ERROR', { error: `Batch ${batchNum} failed: ${err.message}` });
      }
    }
    
    const summaryMsg = `\n✅ <b>List Export Complete</b>\nTotal connections: ${connections.length}`;
    await queueMessage(
      config.telegramBotToken,
      config.telegramChatId,
      summaryMsg
    );
    
    console.log('[Lumen] All batches sent successfully');
    
  } catch (err) {
    console.error('[Lumen] Telegram send error:', err);
    notifyPopup('TELEGRAM_ERROR', { error: err.message });
  }
}

async function sendContactToTelegram(contact) {
  try {
    const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
    
    if (!config.telegramBotToken || !config.telegramChatId) {
      notifyPopup('TELEGRAM_ERROR', { error: 'Telegram config not set' });
      return;
    }
    
    const message = formatContactMessage(contact);
    
    await queueMessage(
      config.telegramBotToken,
      config.telegramChatId,
      message
    );
    
    console.log(`[Lumen] Sent contact ${contact.index}/${contact.total}: ${contact.name}`);
    notifyPopup('CONTACT_SENT', { 
      index: contact.index, 
      total: contact.total, 
      name: contact.name,
      hasEmail: !!contact.email,
      hasPhone: !!contact.phone
    });
    
  } catch (err) {
    console.error(`[Lumen] Failed to send contact:`, err);
    notifyPopup('TELEGRAM_ERROR', { error: `Contact send failed: ${err.message}` });
  }
}

async function sendScrapingComplete(connections, failedProfiles = []) {
  try {
    const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
    
    if (!config.telegramBotToken || !config.telegramChatId) {
      return;
    }
    
    const withEmail = connections.filter(c => c.email).length;
    const withPhone = connections.filter(c => c.phone).length;
    
    let summary = `🎉 <b>Scraping Complete!</b>\n\n` +
      `Total connections: ${connections.length}\n` +
      `With email: ${withEmail}\n` +
      `With phone: ${withPhone}`;
    
    if (failedProfiles.length > 0) {
      summary += `\n\n⚠️ <b>Failed (${failedProfiles.length}):</b>\n`;
      failedProfiles.slice(0, 10).forEach(f => {
        summary += `• ${escapeHtml(f.name)}\n`;
      });
      if (failedProfiles.length > 10) {
        summary += `...and ${failedProfiles.length - 10} more`;
      }
    }
    
    await queueMessage(
      config.telegramBotToken,
      config.telegramChatId,
      summary
    );
    
    console.log('[Lumen] Scraping complete summary sent');
    
  } catch (err) {
    console.error('[Lumen] Failed to send scraping complete:', err);
  }
}

async function sendPauseAlert(reason, message) {
  try {
    const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
    
    if (!config.telegramBotToken || !config.telegramChatId) {
      return;
    }
    
    const alertMsg = `⚠️ <b>Lumen Scraping Paused</b>\n\n` +
      `<b>Reason:</b> ${escapeHtml(reason)}\n` +
      `<b>Details:</b> ${escapeHtml(message)}\n\n` +
      `<i>Please resolve the issue and click "Resume" to continue.</i>`;
    
    await queueMessage(
      config.telegramBotToken,
      config.telegramChatId,
      alertMsg
    );
    
    console.log('[Lumen] Pause alert sent to Telegram');
    
  } catch (err) {
    console.error('[Lumen] Failed to send pause alert:', err);
  }
}

// ============================================
// Error Log Storage
// ============================================

async function storeErrorLog(error) {
  try {
    const { lumen_error_logs = [] } = await chrome.storage.local.get('lumen_error_logs');
    
    lumen_error_logs.push(error);
    if (lumen_error_logs.length > 50) {
      lumen_error_logs.shift();
    }
    
    await chrome.storage.local.set({ lumen_error_logs });
    
  } catch (err) {
    console.error('[Lumen] Failed to store error log:', err);
  }
}

// ============================================
// Notify Popup
// ============================================

function notifyPopup(type, data = {}) {
  chrome.runtime.sendMessage({ type, ...data }).catch(() => {
    // Popup might be closed, that's okay
  });
}

// ============================================
// Test Telegram Connection
// ============================================

async function testTelegramConnection() {
  try {
    const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
    
    if (!config.telegramBotToken || !config.telegramChatId) {
      return { success: false, error: 'Config not set' };
    }
    
    const testMessage = '✅ <b>Lumen Test Message</b>\n\nYour Telegram connection is working!';
    
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      testMessage
    );
    
    return { success: true };
    
  } catch (err) {
    console.error('[Lumen] Test connection failed:', err);
    return { success: false, error: err.message };
  }
}

// ============================================
// Message Listener
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TEST_TELEGRAM':
      testTelegramConnection().then(result => {
        sendResponse(result);
      });
      return true;
      
    case 'SEND_TO_TELEGRAM':
      sendConnectionsToTelegram(message.connections);
      sendResponse({ status: 'processing' });
      break;
      
    case 'SEND_CONTACT_TO_TELEGRAM':
      sendContactToTelegram(message.contact);
      sendResponse({ status: 'processing' });
      break;
      
    case 'SCRAPING_COMPLETE':
      sendScrapingComplete(message.connections, message.failedProfiles || []);
      notifyPopup('SCRAPING_COMPLETE', { 
        total: message.connections?.length || 0,
        failed: message.failedProfiles?.length || 0
      });
      sendResponse({ status: 'done' });
      break;
      
    case 'SCRAPE_PAUSED':
      console.log(`[Lumen] Scrape paused: ${message.reason} - ${message.message}`);
      notifyPopup('SCRAPE_PAUSED', {
        reason: message.reason,
        message: message.message
      });
      sendPauseAlert(message.reason, message.message);
      sendResponse({ status: 'paused' });
      break;
      
    case 'ERROR_LOG':
      console.error(`[Lumen] Error logged:`, message.error);
      storeErrorLog(message.error);
      sendResponse({ status: 'logged' });
      break;
      
    case 'STATUS':
    case 'EXTRACTION_COMPLETE':
    case 'EXTRACTION_ERROR':
      // Forward to popup
      chrome.runtime.sendMessage(message).catch(() => {});
      break;
  }
  
  return true;
});

// Log that service worker is running
console.log('[Lumen] Background service worker started');

// Load and process any queued messages from previous session
loadMessageQueue();
