/**
 * background.js - Service Worker for Telegram API communication
 * 
 * Responsibilities:
 * - Receive extracted connections from content script
 * - Batch connections list into Telegram-safe messages (<4096 chars)
 * - Send individual contact info messages
 * - Send to Telegram Bot API
 * 
 * This is the ONLY place that makes external network calls.
 */

// ============================================
// Configuration
// ============================================

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_MESSAGE_LENGTH = 4000;
const BATCH_DELAY = 1000;

// ============================================
// Telegram API
// ============================================

async function sendTelegramMessage(botToken, chatId, text) {
  const url = `${TELEGRAM_API_BASE}${botToken}/sendMessage`;
  
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
        await sendTelegramMessage(
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
    await sendTelegramMessage(
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
    
    await sendTelegramMessage(
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

async function sendScrapingComplete(connections) {
  try {
    const config = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
    
    if (!config.telegramBotToken || !config.telegramChatId) {
      return;
    }
    
    // Count stats
    const withEmail = connections.filter(c => c.email).length;
    const withPhone = connections.filter(c => c.phone).length;
    
    const summary = `🎉 <b>Scraping Complete!</b>\n\n` +
      `Total connections: ${connections.length}\n` +
      `With email: ${withEmail}\n` +
      `With phone: ${withPhone}`;
    
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      summary
    );
    
    console.log('[Lumen] Scraping complete summary sent');
    
  } catch (err) {
    console.error('[Lumen] Failed to send scraping complete:', err);
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
// Message Listener
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SEND_TO_TELEGRAM':
      sendConnectionsToTelegram(message.connections);
      sendResponse({ status: 'processing' });
      break;
      
    case 'SEND_CONTACT_TO_TELEGRAM':
      sendContactToTelegram(message.contact);
      sendResponse({ status: 'processing' });
      break;
      
    case 'SCRAPING_COMPLETE':
      sendScrapingComplete(message.connections);
      sendResponse({ status: 'done' });
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
