// content.js — Shopify Finder v7
// KEY FIX: content script now writes shopifyUrls AND savedAds directly to storage
// so data is never lost when popup is closed.
(function () {
  'use strict';
  if (window.__sfLoaded) return;
  window.__sfLoaded = true;

  // ── State ─────────────────────────────────────────────────────────────────────
  let isRunning        = false;
  let autoScroll       = true;
  let observer         = null;
  let scanTimer        = null;
  let scrollTimer      = null;
  let processing       = false;
  let scrollStuckCount = 0;
  let lastScrollHeight = 0;

  const stats             = { shopify: 0, scanned: 0, hidden: 0 };
  const checkedDomains    = new Map();  // domain → true|false
  const processedCardKeys = new Set();  // dedup key for cards already saved

  // ── Messages ───────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_SCAN') {
      startScan(msg.autoScroll !== false);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'STOP_SCAN') {
      stopScan();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'SET_SCROLL') {
      autoScroll = !!msg.value;
      if (autoScroll && isRunning) scheduleScroll(300);
      sendResponse({ ok: true });
      return true;
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────────
  function startScan(withScroll) {
    isRunning        = true;
    autoScroll       = withScroll;
    processing       = false;
    scrollStuckCount = 0;
    lastScrollHeight = document.documentElement.scrollHeight;
    restoreAll();
    stats.shopify = stats.scanned = stats.hidden = 0;
    sendStats();
    startObserver();
    scheduleScan(300);
    if (autoScroll) scheduleScroll(1500);
  }

  function stopScan() {
    isRunning  = false;
    autoScroll = false;
    processing = false;
    clearTimeout(scanTimer);
    clearTimeout(scrollTimer);
    if (observer) { observer.disconnect(); observer = null; }
  }

  // ── Auto-scroll ────────────────────────────────────────────────────────────────
  function scheduleScroll(delay) {
    clearTimeout(scrollTimer);
    if (!isRunning || !autoScroll) return;
    scrollTimer = setTimeout(doScroll, delay);
  }

  function doScroll() {
    if (!isRunning || !autoScroll) return;
    const scrollH  = document.documentElement.scrollHeight;
    const atBottom = window.scrollY + window.innerHeight >= scrollH - 300;
    if (atBottom) {
      if (scrollH === lastScrollHeight) scrollStuckCount++;
      else { scrollStuckCount = 0; lastScrollHeight = scrollH; }
      if (scrollStuckCount >= 5) {
        autoScroll = false;
        notify({ type: 'SCROLL_DONE' });
        return;
      }
      scheduleScroll(2500);
    } else {
      scrollStuckCount = 0;
      lastScrollHeight = scrollH;
      window.scrollBy({ top: Math.max(400, window.innerHeight - 150), behavior: 'smooth' });
      scheduleScroll(2000);
    }
  }

  // ── Scan loop ──────────────────────────────────────────────────────────────────
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(runScan, delay);
  }

  async function runScan() {
    if (!isRunning || processing) return;
    processing = true;
    const linkMap = collectExternalLinks();
    log(`Scan: ${linkMap.size} domains`);

    for (const [domain, { url, anchors }] of linkMap) {
      if (!isRunning) break;
      if (checkedDomains.has(domain)) {
        for (const a of anchors) applyToAnchor(a, url, checkedDomains.get(domain));
        continue;
      }
      stats.scanned++;
      sendStats();

      if (domain.endsWith('.myshopify.com')) {
        checkedDomains.set(domain, true);
        for (const a of anchors) applyToAnchor(a, url, true);
        stats.shopify++;
        await saveShopifyUrl(`https://${domain}`);
        sendStats();
        continue;
      }

      let isShopify = false;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'CHECK_SHOPIFY', url: `https://${domain}` });
        isShopify = !!(res && res.isShopify);
      } catch (e) { log('CHECK_SHOPIFY err:', e.message); }

      checkedDomains.set(domain, isShopify);
      if (isShopify) {
        stats.shopify++;
        await saveShopifyUrl(`https://${domain}`);
        for (const a of anchors) applyToAnchor(a, url, true);
      } else {
        stats.hidden++;
        for (const a of anchors) applyToAnchor(a, url, false);
      }
      sendStats();
      await sleep(60);
    }
    processing = false;
  }

  // ── CRITICAL: Save shopify URL directly to storage (don't rely on popup) ──────
  async function saveShopifyUrl(url) {
    return new Promise(resolve => {
      chrome.storage.local.get(['shopifyUrls'], (r) => {
        if (chrome.runtime.lastError) { resolve(); return; }
        const urls = Array.isArray(r.shopifyUrls) ? r.shopifyUrls : [];
        if (urls.includes(url)) { resolve(); return; }
        urls.push(url);
        chrome.storage.local.set({ shopifyUrls: urls }, () => {
          // Notify popup so it can update its UI if open
          notify({ type: 'SHOPIFY_FOUND', url });
          resolve();
        });
      });
    });
  }

  // ── Link collection ────────────────────────────────────────────────────────────
  function collectExternalLinks() {
    const map = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const url = decodeExternalUrl(a.href) || decodeExternalUrl(a.getAttribute('href'));
      if (!url) continue;
      let domain;
      try { domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
      catch { continue; }
      if (!domain || domain.length < 4) continue;
      if (!map.has(domain)) map.set(domain, { url, anchors: new Set() });
      map.get(domain).anchors.add(a);
    }
    return map;
  }

  function decodeExternalUrl(href) {
    if (!href) return null;
    if (href.includes('l.facebook.com/l.php') || href.includes('/l.php?')) {
      try {
        const base = href.startsWith('http') ? href : 'https://x.com' + href;
        const u = new URL(base).searchParams.get('u');
        if (u) return decodeURIComponent(u);
      } catch (_) {}
    }
    return isExternal(href) ? href : null;
  }

  function isExternal(url) {
    if (!url || !url.startsWith('http')) return false;
    return !['facebook.com','fb.com','instagram.com','fbcdn.net',
             'whatsapp.com','messenger.com','fb.me','facebookmail.com'].some(b => url.includes(b));
  }

  // ── Apply result ───────────────────────────────────────────────────────────────
  function applyToAnchor(anchor, url, isShopify) {
    const card = findCardRoot(anchor);
    if (!card) return;
    const status = card.getAttribute('data-sf-status');
    if (status === 'shopify') return;
    if (status === 'hidden' && isShopify) { showCard(card); collectAd(card, url); return; }
    if (status) return;
    if (isShopify) { showCard(card); collectAd(card, url); }
    else hideCard(card);
  }

  // ── Card root finder ───────────────────────────────────────────────────────────
  function findCardRoot(el) {
    let cur = el, best = null;
    for (let d = 0; d < 25; d++) {
      cur = cur?.parentElement;
      if (!cur || cur === document.body) break;
      if (cur.offsetHeight < 180 || cur.offsetWidth < 180) continue;
      const parent = cur.parentElement;
      if (!parent) continue;
      const peers = [...parent.children].filter(c => c !== cur && c.offsetHeight > 180);
      if (peers.length >= 1) { best = cur; if (d >= 3) break; }
    }
    return best;
  }

  // ── Ad extraction ──────────────────────────────────────────────────────────────
  function extractAdData(card, shopifyUrl) {
    const ad = {
      shopifyUrl,
      advertiserName: '',
      advertiserLogo: '',
      adText:         '',
      images:         [],
      videos:         [],
      libraryCode:    '',
      scrapedAt:      new Date().toISOString(),
    };

    const text = card.innerText || '';

    // Library code
    const codeMatch = text.match(/\b(\d{13,16})\b/);
    if (codeMatch) ad.libraryCode = codeMatch[1];

    // Advertiser name — find "Sponsorlu/Sponsored" leaf, grab name from sibling
    const SPONSOR_RE = /^(Sponsorlu|Sponsored|Patrocinado|Sponsorisé|Sponsert|Gesponsert)$/i;
    for (const el of card.querySelectorAll('*')) {
      const t = (el.innerText || '').trim();
      if (!SPONSOR_RE.test(t) || el.children.length > 0) continue;
      let probe = el.parentElement;
      for (let i = 0; i < 7 && probe; i++) {
        const prev = probe.previousElementSibling;
        if (prev) {
          const name = (prev.innerText || '').trim().split('\n')[0].trim();
          if (name && name.length > 1 && name.length < 80) {
            ad.advertiserName = name;
            break;
          }
        }
        probe = probe.parentElement;
      }
      // Avatar image near sponsor label
      const wrap = el.closest('div');
      if (wrap) {
        for (const img of wrap.querySelectorAll('img')) {
          if (img.src && !img.src.startsWith('data:') && img.offsetWidth > 20) {
            ad.advertiserLogo = img.src;
            break;
          }
        }
      }
      break;
    }

    // Ad body text — longest non-meta leaf
    const META_RE = /^(Kütüphane|Library\s+Code|Sponsorlu|Sponsored|Platform|Reklam|See Ad|Özet|Summary|Bu reklam|This ad|\d{10,}|Aktif|Active|Tümünü|Shop Now|Learn More|Sign Up|Book Now)/i;
    let longest = '';
    for (const el of card.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const t = (el.innerText || '').trim();
      if (t.length > longest.length && !META_RE.test(t) && t.length > 15 && t.length < 600) {
        longest = t;
      }
    }
    ad.adText = longest;

    // Images — content images only, skip avatars/icons, cap at 3
    for (const img of card.querySelectorAll('img')) {
      if (ad.images.length >= 3) break;
      const src = firstUsableMediaUrl(img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('src'));
      if (!src || src.startsWith('data:') || src.includes('emoji')) continue;
      const w = img.naturalWidth  || img.offsetWidth  || 0;
      const h = img.naturalHeight || img.offsetHeight || 0;
      if (w < 100 || h < 100) continue;
      if (!ad.images.includes(src)) ad.images.push(src);
    }

    // Videos + poster thumbnail
    for (const vid of card.querySelectorAll('video')) {
      if (ad.videos.length >= 2) break;
      const sourceUrls = [...vid.querySelectorAll('source')].flatMap(source => [
        source.src,
        source.getAttribute('src'),
        source.getAttribute('data-src'),
      ]);
      const src = firstUsableMediaUrl(
        vid.currentSrc,
        vid.src,
        vid.getAttribute('src'),
        vid.getAttribute('data-src'),
        ...sourceUrls
      );
      if (src) {
        if (!ad.videos.includes(src)) ad.videos.push(src);
      }
      if (vid.poster && ad.images.length < 3) {
        const poster = firstUsableMediaUrl(vid.poster, vid.getAttribute('poster'));
        if (poster && !ad.images.includes(poster)) ad.images.push(poster);
      }
    }

    return ad;
  }

  function firstUsableMediaUrl(...sources) {
    for (const source of sources) {
      const url = String(source || '').trim();
      if (!url) continue;
      if (url.startsWith('blob:')) continue;
      if (url.startsWith('data:')) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      return url;
    }
    return '';
  }

  // ── Collect and save ad to storage ────────────────────────────────────────────
  function collectAd(card, url) {
    const ad  = extractAdData(card, url);
    const key = ad.libraryCode || url;
    if (processedCardKeys.has(key)) return;
    processedCardKeys.add(key);

    log('Collected:', ad.advertiserName || '?', '| code:', ad.libraryCode || '-', '| imgs:', ad.images.length);

    saveAd(ad);
  }

  function saveAd(ad, stripMedia = false) {
    if (stripMedia) {
      ad = { ...ad, images: [], videos: [], advertiserLogo: '' };
    }

    chrome.storage.local.get(['savedAds'], (r) => {
      if (chrome.runtime.lastError) { log('Read err:', chrome.runtime.lastError.message); return; }

      const existing = Array.isArray(r.savedAds) ? r.savedAds : [];

      const existingIndex = ad.libraryCode
        ? existing.findIndex(e => e.libraryCode === ad.libraryCode)
        : existing.findIndex(e =>
            e.shopifyUrl === ad.shopifyUrl &&
            e.adText === ad.adText
          );
      if (existingIndex >= 0) {
        const merged = mergeSavedAd(existing[existingIndex], ad);
        if (JSON.stringify(merged) === JSON.stringify(existing[existingIndex])) {
          log('Already in storage');
          return;
        }
        existing[existingIndex] = merged;
        chrome.storage.local.set({ savedAds: existing }, () => {
          if (chrome.runtime.lastError) { log('Update err:', chrome.runtime.lastError.message); return; }
          log('Updated media for saved ad:', merged.libraryCode || merged.shopifyUrl);
          notify({ type: 'AD_COLLECTED', total: existing.length });
        });
        return;
      }

      // Rolling cap at 500 ads
      if (existing.length >= 500) existing.splice(0, existing.length - 499);
      existing.push(ad);

      chrome.storage.local.set({ savedAds: existing }, () => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || '';
          log('Write err:', msg);
          if (!stripMedia && (msg.includes('QUOTA') || msg.includes('quota') || msg.includes('exceeded'))) {
            log('Quota hit — retrying without media');
            saveAd(ad, true); // retry without images/videos
          }
          return;
        }
        log('Saved. Total in storage:', existing.length);
        notify({ type: 'AD_COLLECTED', total: existing.length });
      });
    });
  }

  function mergeSavedAd(current, next) {
    return {
      ...current,
      shopifyUrl: next.shopifyUrl || current.shopifyUrl,
      advertiserName: next.advertiserName || current.advertiserName,
      advertiserLogo: next.advertiserLogo || current.advertiserLogo,
      adText: next.adText || current.adText,
      images: mergeMediaUrls(current.images, next.images, 3),
      videos: mergeMediaUrls(current.videos, next.videos, 2),
      scrapedAt: next.scrapedAt || current.scrapedAt,
    };
  }

  function mergeMediaUrls(currentList, nextList, limit) {
    const urls = [];
    const seen = new Set();
    for (const raw of [...(nextList || []), ...(currentList || [])]) {
      const url = firstUsableMediaUrl(raw);
      if (!url) continue;
      const key = url.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
      if (urls.length >= limit) break;
    }
    return urls;
  }

  // ── Card styling ───────────────────────────────────────────────────────────────
  function hideCard(card) {
    card.setAttribute('data-sf-status', 'hidden');
    card.style.opacity    = '0.1';
    card.style.filter     = 'grayscale(1) blur(0.5px)';
    card.style.transition = 'opacity 0.2s, filter 0.2s';
  }

  function showCard(card) {
    card.setAttribute('data-sf-status', 'shopify');
    card.style.opacity      = '1';
    card.style.filter       = '';
    card.style.transition   = '';
    card.style.outline      = '2.5px solid #96bf48';
    card.style.borderRadius = '10px';
    card.style.boxShadow    = '0 0 0 5px rgba(150,191,72,0.13)';
  }

  function restoreAll() {
    document.querySelectorAll('[data-sf-status]').forEach(el => {
      el.removeAttribute('data-sf-status');
      ['opacity','filter','outline','boxShadow','transition','borderRadius'].forEach(p => el.style[p] = '');
    });
  }

  // ── MutationObserver ───────────────────────────────────────────────────────────
  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => { if (isRunning) scheduleScan(700); });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log   = (...a) => console.log('[SF v7]', ...a);

  function sendStats() {
    notify({ type: 'STATS_UPDATE', stats: { ...stats } });
  }

  // Fire-and-forget notify to popup (ok if popup is closed)
  function notify(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  log('v7 loaded');
  notify({ type: 'CONTENT_READY' });
})();
