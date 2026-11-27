const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHref(url) {
  return String(url || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '%22');
}

/**
 * Compact deal format:
 * Product Name
 * MRP: ₹X | Price: ₹Y | Z% OFF
 * Click here (direct link)
 */
function formatCompactItem(deal, index = null) {
  const directUrl = deal.itemLink || deal.searchLink || `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(deal.name)}`;
  const safeUrl = escapeHref(directUrl);
  const num = index !== null ? `${index}. ` : '• ';

  return (
`${num}<b>${escapeHtml(deal.name)}</b>
MRP: ₹${deal.mrp} | Price: ₹${deal.price} | <b>${deal.discount}% OFF</b>
<a href="${safeUrl}">Click here</a>`
  );
}

function formatDealMessage(deal) {
  return formatCompactItem(deal);
}

async function sendTelegramSafe(bot, chatId, htmlText) {
  try {
    await bot.sendMessage(chatId, htmlText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return true;
  } catch (err) {
    const detail = err?.response?.body
      ? JSON.stringify(err.response.body)
      : (err.message || String(err));
    console.error(`[Notifier] ❌ HTML send failed for chat ${chatId}: ${detail}`);

    // Fallback to plain text if Telegram rejected HTML formatting
    if (String(detail).toLowerCase().includes('parse entities')) {
      const plainText = htmlText
        .replace(/<a href="([^"]+)">([^<]+)<\/a>/gi, '$2: $1')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
      try {
        await bot.sendMessage(chatId, plainText, { disable_web_page_preview: true });
        console.log(`[Notifier] ✅ Sent plain-text fallback to chat ${chatId}.`);
        return true;
      } catch (fallbackErr) {
        const fbDetail = fallbackErr?.response?.body
          ? JSON.stringify(fallbackErr.response.body)
          : (fallbackErr.message || String(fallbackErr));
        console.error(`[Notifier] ❌ Plain-text fallback also failed: ${fbDetail}`);
      }
    }
    return false;
  }
}

async function sendDealAlert(bot, chatId, deal) {
  const text = formatCompactItem(deal);
  return sendTelegramSafe(bot, chatId, text);
}

/**
 * Clubs deals together into consolidated messages (one message per worker),
 * chunking only if character length exceeds Telegram's 4096 character limit.
 */
async function sendBatchAlerts(bot, chatId, deals, options = {}) {
  if (!deals || !deals.length) return;
  console.log(`[Notifier] Sending ${deals.length} deals in consolidated message(s) to chat ${chatId}…`);

  const timeTag = options.timeString ? ` • ${escapeHtml(options.timeString)}` : '';
  const headerTag = options.workerInfo
    ? `<b>[${escapeHtml(options.workerInfo)} • ${deals.length} Found${timeTag}]</b>\n\n`
    : `<b>[Instamart Deals • ${deals.length} Found${timeTag}]</b>\n\n`;

  const messages = [];
  let currentMsg = headerTag;

  for (let i = 0; i < deals.length; i++) {
    const itemText = formatCompactItem(deals[i], i + 1) + '\n\n';

    if ((currentMsg + itemText).length > 3800) {
      messages.push(currentMsg.trim());
      currentMsg = itemText;
    } else {
      currentMsg += itemText;
    }
  }

  if (currentMsg.trim()) {
    messages.push(currentMsg.trim());
  }

  for (let i = 0; i < messages.length; i++) {
    const ok = await sendTelegramSafe(bot, chatId, messages[i]);
    if (ok) {
      console.log(`[Notifier] ✅ Delivered message ${i + 1}/${messages.length} to chat ${chatId}.`);
    }
    if (i < messages.length - 1) {
      await sleep(1000);
    }
  }
}

module.exports = {
  formatCompactItem,
  formatDealMessage,
  sendDealAlert,
  sendBatchAlerts
};
