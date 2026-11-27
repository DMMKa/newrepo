require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config.json');
const { fetchEssentialAisleDeals, fetchNoiceDeals } = require('./swiggyApi');
const { findAlertWorthyDeals } = require('./dealTracker');
const { sendBatchAlerts } = require('./notifier');
const { getUser } = require('./userManager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const minDiscount = parseInt(process.env.MIN_DISCOUNT_PERCENT, 10) || config.minDiscount || 70;

// Parse command line arguments
const args = process.argv.slice(2);
let mode = 'auto';
let skipSync = false;
let storeFilter = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--skip-sync') {
    skipSync = true;
  } else if (arg.startsWith('--store=')) {
    storeFilter = arg.split('=')[1].trim();
  } else if (!arg.startsWith('--')) {
    mode = arg.toLowerCase();
  }
}

function normalizeStore(s, index = 0) {
  if (!s || typeof s !== 'object') return null;
  const sid = String(s.sid || s.id || s.storeId || '').trim();
  if (!sid) return null;
  const pid = String(s.pid || s.primaryStoreId || sid).trim();
  const secid = String(s.secid || s.secondaryStoreId || '').trim();
  const label = String(s.label || s.name || `Store ${sid || index + 1}`).trim();
  return { sid, pid, secid, label };
}

function resolveStores() {
  let rawList = [];

  // Priority 1: SWIGGY_STORES env var (JSON array)
  if (process.env.SWIGGY_STORES) {
    try {
      const parsed = JSON.parse(process.env.SWIGGY_STORES);
      if (Array.isArray(parsed) && parsed.length > 0) {
        rawList = parsed;
      }
    } catch (e) {
      console.warn('[CronRunner] ⚠️ Failed to parse SWIGGY_STORES JSON env var:', e.message);
    }
  }

  // Priority 2: config.json "stores" array
  if (rawList.length === 0 && Array.isArray(config.stores) && config.stores.length > 0) {
    rawList = config.stores;
  }

  // Priority 3: Single store fallback (env vars or config.store)
  if (rawList.length === 0) {
    const fallbackSid = process.env.SWIGGY_STORE_ID || config.store?.sid || '';
    if (fallbackSid) {
      rawList = [{
        sid: fallbackSid,
        pid: process.env.SWIGGY_PRIMARY_STORE_ID || config.store?.pid || fallbackSid,
        secid: process.env.SWIGGY_SECONDARY_STORE_ID || config.store?.secid || '',
        label: config.store?.label || ''
      }];
    }
  }

  // Normalize and deduplicate by sid + secid
  const seen = new Map();
  const uniqueStores = [];
  rawList.forEach((entry, idx) => {
    const norm = normalizeStore(entry, idx);
    if (!norm) return;
    const dedupKey = `${norm.sid}_${norm.secid}`;
    if (seen.has(dedupKey)) {
      console.warn(`[CronRunner] ⚠️ Duplicate store ID detected (${norm.sid} — "${norm.label}" matches "${seen.get(dedupKey)}"). Skipping duplicate.`);
      return;
    }
    seen.set(dedupKey, norm.label);
    uniqueStores.push(norm);
  });

  if (storeFilter) {
    return uniqueStores.filter((s) => s.sid === storeFilter || s.label.toLowerCase().includes(storeFilter.toLowerCase()));
  }

  return uniqueStores;
}

const activeStores = resolveStores();

if (!activeStores.length) {
  console.error('❌ FATAL: No valid Swiggy Store IDs found!');
  console.error('   Configure "stores" in config.json, or set SWIGGY_STORES / SWIGGY_STORE_ID in GitHub Secrets.');
  process.exit(1);
}

/**
 * Synchronization and Staleness Guard:
 * - Checks for GitHub runner queue delays (>25 min late) on scheduled runs
 * - Pre-slot sync (:00:30 and :30:30 IST) when booted slightly early
 */
async function syncToHourMark(skip = false, targetBufferSecs = 30) {
  if (skip) {
    console.log('[Sync] Synchronization skipped via --skip-sync.');
    return;
  }

  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + istOffsetMs);
  const mins = istNow.getUTCMinutes();
  const secs = istNow.getUTCSeconds();
  const ms = istNow.getUTCMilliseconds();

  const isGitHubScheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
  if (isGitHubScheduled) {
    const delayMins = (mins >= 30) ? (mins - 30) : mins;
    if (delayMins > 25) {
      console.warn(`[Sync] ⚠️ GitHub Actions runner queue was delayed by ~${delayMins}m past the target slot (:01/:31).`);
      console.warn(`[Sync] Current time is ${String(istNow.getUTCHours()).padStart(2, '0')}:${String(mins).padStart(2, '0')} IST.`);
      console.warn(`[Sync] Aborting stale scheduled run to avoid sending outdated deals.`);
      process.exit(0);
    }
  }

  if (mins >= 55 && mins <= 59) {
    const minsLeft = 60 - mins;
    const msToWait = (minsLeft * 60 * 1000) - (secs * 1000) - ms + (targetBufferSecs * 1000);
    if (msToWait > 0 && msToWait <= 6 * 60 * 1000) {
      console.log(`[Sync] Runner woke up early at ${mins}:${String(secs).padStart(2, '0')} IST.`);
      console.log(`[Sync] Waiting ${(msToWait / 1000).toFixed(1)}s until :00:${String(targetBufferSecs).padStart(2, '0')} IST for fresh Swiggy hourly deals...`);
      await sleep(msToWait);
    }
  } else if (mins >= 25 && mins <= 29) {
    const minsLeft = 30 - mins;
    const msToWait = (minsLeft * 60 * 1000) - (secs * 1000) - ms + (targetBufferSecs * 1000);
    if (msToWait > 0 && msToWait <= 6 * 60 * 1000) {
      console.log(`[Sync] Runner woke up early at ${mins}:${String(secs).padStart(2, '0')} IST.`);
      console.log(`[Sync] Waiting ${(msToWait / 1000).toFixed(1)}s until :30:${String(targetBufferSecs).padStart(2, '0')} IST for fresh Swiggy deals...`);
      await sleep(msToWait);
    }
  } else {
    console.log(`[Sync] Running immediately at ${String(istNow.getUTCHours()).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')} IST.`);
  }
}

async function runSubcategoryCampaign(campaignKey, campaignCfg, options = {}) {
  const {
    bot,
    chatId,
    storeConfig,
    storeLabel = '',
    cacheKey = campaignKey,
    threshold,
    timeString,
    forceThreshold = false
  } = options;

  const name = campaignCfg.name || campaignKey;
  const tag = campaignCfg.tag || '';
  const baseHeader = tag ? `${tag} ${name}` : name;
  const headerName = storeLabel ? `${baseHeader} • ${storeLabel}` : baseHeader;
  const subcategories = campaignCfg.subcategories || [];
  const searchKeywords = campaignCfg.searchKeywords || [];

  console.log(`\n--- Running ${headerName} (${subcategories.length} Subcategories, ${searchKeywords.length} Search Keywords) ---`);

  let items = [];
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      console.log(`[${cacheKey}] Fetching deals for ${subcategories.length} aisles & ${searchKeywords.length} keywords (attempt ${attempts}/${maxAttempts})...`);
      items = await fetchEssentialAisleDeals(storeConfig, {
        subcategories,
        searchKeywords,
        campaignName: headerName,
        dealType: campaignKey
      });

      if (items && items.length > 0) {
        console.log(`[${cacheKey}] Scraped ${items.length} items across ${subcategories.length} aisles & ${searchKeywords.length} keywords.`);
        break;
      } else {
        console.warn(`[${cacheKey}] Attempt ${attempts}/${maxAttempts}: Swiggy returned 0 items (server may be busy).`);
      }
    } catch (e) {
      console.error(`[${cacheKey}] Attempt ${attempts}/${maxAttempts} error:`, e.message);
    }

    if (attempts < maxAttempts) {
      const waitSecs = 75;
      console.log(`[${cacheKey}] ⏳ Swiggy busy/failed. Waiting ${waitSecs}s before retry ${attempts + 1}/${maxAttempts}...`);
      await sleep(waitSecs * 1000);
    }
  }

  if (items.length > 0) {
    const refreshCycle = campaignCfg.refreshCycle || 'daily';
    const weeklyResetDay = campaignCfg.weeklyResetDay !== undefined ? campaignCfg.weeklyResetDay : 1;
    const weeklyCategories = campaignCfg.weeklyCategories || config.weeklyCategories || ['Electronics and Appliances'];
    const alerts = findAlertWorthyDeals(items, threshold, cacheKey, {
      refreshCycle,
      weeklyResetDay,
      weeklyCategories,
      forceThreshold: Boolean(forceThreshold)
    });
    console.log(`[${cacheKey}] Found ${alerts.length} alert-worthy deals (Discount ≥ ${threshold}% | Cycle: ${refreshCycle}).`);
    if (bot && chatId && alerts.length > 0) {
      await sendBatchAlerts(bot, chatId, alerts, {
        timeString,
        workerInfo: headerName
      });
    } else if (!alerts.length) {
      console.log(`[${cacheKey}] No items met the minimum discount threshold (${threshold}%) this run.`);
    }
    return true;
  } else {
    console.error(`[${cacheKey}] All retry attempts failed or returned 0 items.`);
    return false;
  }
}

async function main() {
  const isMultiStore = activeStores.length > 1;
  console.log(`[CronRunner] Mode: ${mode.toUpperCase()} | Stores (${activeStores.length}): ${activeStores.map((s) => `${s.label} [${s.sid}]`).join(', ')}`);
  const brandCount = Object.keys(config.brandThresholds || {}).length;
  if (brandCount > 0) {
    console.log(`[CronRunner] 🏷️ Brand Threshold Filter Active (${brandCount} brand rules loaded).`);
  }

  // Synchronize once before scanning stores
  await syncToHourMark(skipSync);

  let bot = null;
  if (token && token !== 'your_bot_token_here') {
    bot = new TelegramBot(token, { polling: false });
  } else {
    console.warn('[CronRunner] No TELEGRAM_BOT_TOKEN configured. Will scrape and cache without sending Telegram alerts.');
  }

  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  const istDay = istDate.getUTCDay();
  const istHours = istDate.getUTCHours();
  const istMinutes = istDate.getUTCMinutes();

  console.log(`[CronRunner] Active IST Time: ${istDate.toUTCString()} (Day: ${istDay}, Hour: ${istHours}:${String(istMinutes).padStart(2, '0')})`);

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const timeString = timeFormatter.format(new Date()) + ' IST';

  const isWithinHours = (istHours >= 9 && istHours <= 23) || (istHours === 0 && istMinutes <= 15);
  const isGitHubScheduled = process.env.GITHUB_EVENT_NAME === 'schedule';

  if (isGitHubScheduled && !isWithinHours) {
    console.log(`[CronRunner] Outside active operating window (9:01 AM - 12:01 AM IST). Current time: ${istHours}:${String(istMinutes).padStart(2, '0')} IST. Exiting.`);
    process.exit(0);
  }

  let runFresh = false;
  let runGrocery = false;
  let runTreats = false;
  let runMunchies = false;
  let runBeverages = false;
  let runPersonal = false;
  let runLifestyle = false;
  let runHousehold = false;
  let runClearance = false;
  let runNoice = false;

  if (mode === 'fresh' || mode === 'produce') {
    runFresh = true;
  } else if (mode === 'grocery' || mode === 'staples') {
    runGrocery = true;
  } else if (mode === 'essentials' || mode === 'keywords' || mode === 'aisles') {
    runFresh = true;
    runGrocery = true;
  } else if (mode === 'treats' || mode === 'sweets') {
    runTreats = true;
  } else if (mode === 'munchies' || mode === 'snacks') {
    runMunchies = true;
  } else if (mode === 'lifestyle' || mode === 'baby') {
    runLifestyle = true;
  } else if (mode === 'household' || mode === 'cleaning') {
    runHousehold = true;
  } else if (mode === 'clearance') {
    runClearance = true;
  } else if (mode === 'beverages' || mode === 'drinks' || mode === 'juices') {
    runBeverages = true;
  } else if (mode === 'personal' || mode === 'personalcare') {
    runPersonal = true;
  } else if (mode === 'noice') {
    runNoice = true;
  } else {
    if (isWithinHours) {
      runFresh = true;
      runGrocery = true;
      runTreats = true;
      runMunchies = true;
      runBeverages = true;
      runPersonal = true;
      runLifestyle = true;
      runHousehold = true;
      runClearance = true;
    }
  }

  const user = chatId ? getUser(chatId, activeStores[0]) : null;
  const userDiscounts = user?.workerDiscounts || {};
  const campaigns = config.campaigns || {};
  let anyWorkerFailed = false;

  for (let sIdx = 0; sIdx < activeStores.length; sIdx++) {
    const store = activeStores[sIdx];
    const storeLabel = isMultiStore ? store.label : (store.label || '');
    const makeCacheKey = (key) => (isMultiStore ? `${key}_${store.sid}` : key);

    console.log(`\n================ 🏪 [${sIdx + 1}/${activeStores.length}] ${store.label || store.sid} (ID: ${store.sid}) ================`);

    // 1. Worker 1: Daily Fresh Produce & Meats
    if (runFresh) {
      const cfg = campaigns.fresh || campaigns.essentials || {};
      const envVal = process.env.FRESH_MIN_DISCOUNT || process.env.ESSENTIALS_MIN_DISCOUNT;
      const userVal = userDiscounts.fresh || userDiscounts.essentials;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 60;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('fresh', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('fresh'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 2. Worker 2: Daily Staples & Cooking Essentials
    if (runGrocery) {
      const cfg = campaigns.grocery || campaigns.essentials || {};
      const envVal = process.env.GROCERY_MIN_DISCOUNT || process.env.ESSENTIALS_MIN_DISCOUNT;
      const userVal = userDiscounts.grocery || userDiscounts.essentials;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 60;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('grocery', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('grocery'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 3. Worker 3: Sweets, Chocolates & Bakery
    if (runTreats) {
      const cfg = campaigns.treats || {};
      const envVal = process.env.TREATS_MIN_DISCOUNT;
      const userVal = userDiscounts.treats;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 70;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('treats', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('treats'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 4. Worker 4: Snacks, Munchies & Instant Foods
    if (runMunchies) {
      const cfg = campaigns.munchies || campaigns.treats || {};
      const envVal = process.env.MUNCHIES_MIN_DISCOUNT || (process.env.TREATS_MIN_DISCOUNT ? process.env.TREATS_MIN_DISCOUNT : null);
      const userVal = userDiscounts.munchies;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 70;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('munchies', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('munchies'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 5. Worker 5: Cold Drinks, Nutrition & Spreads
    if (runBeverages) {
      const cfg = campaigns.beverages || {};
      const envVal = process.env.BEVERAGES_MIN_DISCOUNT;
      const userVal = userDiscounts.beverages;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 70;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('beverages', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('beverages'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 6. Worker 6: Personal Care, Bath & Skincare
    if (runPersonal) {
      const cfg = campaigns.personalCare || campaigns.personal || {};
      const envVal = process.env.PERSONAL_MIN_DISCOUNT || process.env.PERSONALCARE_MIN_DISCOUNT;
      const userVal = userDiscounts.personalCare || userDiscounts.personal;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 70;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('personalCare', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('personalCare'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 7. Worker 7: Baby Care & Lifestyle
    if (runLifestyle) {
      const cfg = campaigns.lifestyle || {};
      const envVal = process.env.LIFESTYLE_MIN_DISCOUNT;
      const userVal = userDiscounts.lifestyle;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 85;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('lifestyle', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('lifestyle'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 8. Worker 8: Cleaning, Home & Electronics
    if (runHousehold) {
      const cfg = campaigns.household || campaigns.cleaning || {};
      const envVal = process.env.HOUSEHOLD_MIN_DISCOUNT || process.env.CLEANING_MIN_DISCOUNT;
      const userVal = userDiscounts.household;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 70;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('household', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('household'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 9. Worker 9: High-Discount Clearance Specials
    if (runClearance) {
      const cfg = campaigns.clearance || {};
      const envVal = process.env.CLEARANCE_MIN_DISCOUNT;
      const userVal = userDiscounts.clearance;
      const threshold = parseInt(envVal || userVal, 10) || cfg.minDiscount || 89;
      const forceThreshold = Boolean(envVal || userVal);
      const ok = await runSubcategoryCampaign('clearance', cfg, {
        bot,
        chatId,
        storeConfig: store,
        storeLabel,
        cacheKey: makeCacheKey('clearance'),
        threshold,
        forceThreshold,
        timeString
      });
      if (!ok) anyWorkerFailed = true;
    }

    // 10. The NOICE Store Scan
    if (runNoice) {
      console.log(`\n--- Running The NOICE Store Scan (${store.label || store.sid}) ---`);
      const cfg = campaigns.noice || {};
      const noiceThreshold = parseInt(process.env.NOICE_MIN_DISCOUNT, 10) || cfg.minDiscount || minDiscount || 50;
      const noiceCacheKey = makeCacheKey('noice');
      const noiceHeader = storeLabel ? `✨ The NOICE Store • ${storeLabel}` : '✨ The NOICE Store';
      try {
        const items = await fetchNoiceDeals(store);
        if (!items || items.length === 0) {
          anyWorkerFailed = true;
        } else {
          console.log(`[${noiceCacheKey}] Scraped ${items.length} items.`);
          const alerts = findAlertWorthyDeals(items, noiceThreshold, noiceCacheKey, {
            refreshCycle: cfg.refreshCycle || 'weekly',
            weeklyResetDay: cfg.weeklyResetDay !== undefined ? cfg.weeklyResetDay : 1
          });
          console.log(`[${noiceCacheKey}] Found ${alerts.length} new/improved deals >= ${noiceThreshold}%.`);
          if (bot && chatId && alerts.length > 0) {
            await sendBatchAlerts(bot, chatId, alerts, { timeString, workerInfo: noiceHeader });
          }
        }
      } catch (e) {
        console.error(`[${noiceCacheKey}] Error:`, e.message);
        anyWorkerFailed = true;
      }
    }

    // Short cooldown between stores to stay friendly with Swiggy WAF
    if (sIdx < activeStores.length - 1) {
      await sleep(2000);
    }
  }

  if (anyWorkerFailed) {
    console.error('\n[CronRunner] One or more store scans failed to scrape items (server busy/throttled). Exiting with code 1 for auto-retry.');
    process.exit(1);
  }

  console.log('\n[CronRunner] Execution finished successfully across all stores.');
}

main().catch((err) => {
  console.error('[CronRunner] Fatal error:', err);
  process.exit(1);
});
