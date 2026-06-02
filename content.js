// content.js — Shopify Finder v3
// Strategy: scan ALL links on the page, find external ones, dedupe by domain,
// check each domain for Shopify via background.js, then style parent containers.
// This approach is DOM-structure-independent and works regardless of FB's class names.

(function () {
  'use strict';

  if (window.__sfLoaded) return;
  window.__sfLoaded = true;

  // ── State ────────────────────────────────────────────────────────────────────
  let isRunning  = false;
  let observer   = null;
  let scanTimer  = null;
  let processing = false;

  const stats          = { shopify: 0, scanned: 0, hidden: 0 };
  const checkedDomains = new Map();   // domain → true | false
  const processedLinks = new WeakSet(); // <a> elements already processed

  // ── Messaging ─────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_SCAN') { startScan(); sendResponse({ ok: true }); return true; }
    if (msg.type === 'STOP_SCAN')  { stopScan();  sendResponse({ ok: true }); return true; }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  function startScan() {
    if (isRunning) return;
    isRunning = true;
    stats.shopify = stats.scanned = stats.hidden = 0;
    restoreAll();
    sendStats();
    startObserver();
    scheduleScan(200);
  }

  function stopScan() {
    isRunning = false;
    clearTimeout(scanTimer);
    if (observer) { observer.disconnect(); observer = null; }
    log('Scan stopped.');
  }

  // ── Core scan ─────────────────────────────────────────────────────────────────
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(runScan, delay);
  }

  async function runScan() {
    if (!isRunning || processing) return;
    processing = true;

    // Collect all new external links on the page right now
    const linkMap = collectExternalLinks();
    log(`Found ${linkMap.size} unique external domains to process`);

    for (const [domain, { url, anchors }] of linkMap) {
      if (!isRunning) break;

      // Skip already checked domains — just apply the cached result visually
      if (checkedDomains.has(domain)) {
        const cached = checkedDomains.get(domain);
        anchors.forEach(a => {
          if (!processedLinks.has(a)) {
            processedLinks.add(a);
            applyToAnchor(a, url, cached);
          }
        });
        continue;
      }

      // Mark all these anchors as in-progress
      anchors.forEach(a => processedLinks.add(a));

      stats.scanned++;
      sendStats();

      // Instant check
      if (domain.endsWith('.myshopify.com')) {
        checkedDomains.set(domain, true);
        anchors.forEach(a => applyToAnchor(a, url, true));
        stats.shopify++;
        sendShopifyFound(`https://${domain}`);
        sendStats();
        continue;
      }

      // Ask background (CORS-free)
      let isShopify = false;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'CHECK_SHOPIFY', url: `https://${domain}` });
        isShopify = !!(res && res.isShopify);
      } catch (e) {
        log('CHECK_SHOPIFY error:', e.message);
      }

      checkedDomains.set(domain, isShopify);

      if (isShopify) {
        stats.shopify++;
        sendShopifyFound(`https://${domain}`);
        anchors.forEach(a => applyToAnchor(a, url, true));
      } else {
        stats.hidden++;
        anchors.forEach(a => applyToAnchor(a, url, false));
      }

      sendStats();
      await sleep(60);
    }

    processing = false;
  }

  // ── Link collection ───────────────────────────────────────────────────────────
  /**
   * Returns Map<domain, { url, anchors: Set<Element> }>
   * 
   * Meta Ads Library wraps CTA links in one of these patterns:
   *   1. <a href="https://l.facebook.com/l.php?u=ENCODED_URL&...">
   *   2. <a href="https://www.facebook.com/ads/...">  ← internal, skip
   *   3. Plain text domain shown in card (no link at all in some views)
   *
   * We decode FB redirect URLs and bucket by root domain.
   */
  function collectExternalLinks() {
    const map = new Map();

    const allAnchors = document.querySelectorAll('a[href]');
    for (const a of allAnchors) {
      const rawHref = a.getAttribute('href') || '';
      const href    = a.href || '';

      let url = decodeExternalUrl(href) || decodeExternalUrl(rawHref);
      if (!url) continue;

      let domain;
      try {
        domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      } catch { continue; }

      if (!domain || domain.length < 4) continue;

      if (!map.has(domain)) {
        map.set(domain, { url, anchors: new Set() });
      }
      map.get(domain).anchors.add(a);
    }

    return map;
  }

  function decodeExternalUrl(href) {
    if (!href) return null;

    // Facebook redirect: l.facebook.com/l.php?u=<encoded>
    if (href.includes('l.facebook.com/l.php') || href.includes('/l.php?')) {
      try {
        const params = new URL(href.startsWith('http') ? href : 'https://x.com' + href).searchParams;
        const u = params.get('u');
        if (u) return decodeURIComponent(u);
      } catch (_) {}
    }

    // Direct external link
    if (isExternal(href)) return href;

    return null;
  }

  function isExternal(url) {
    if (!url || !url.startsWith('http')) return false;
    const BLOCKED = [
      'facebook.com', 'fb.com', 'instagram.com', 'fbcdn.net',
      'whatsapp.com', 'messenger.com', 'fb.me', 'facebookmail.com',
      'about.fb.com', 'business.facebook.com'
    ];
    return !BLOCKED.some(b => url.includes(b));
  }

  // ── Apply results to DOM ───────────────────────────────────────────────────────
  /**
   * Given an anchor element, walk up the DOM to find its ad card container,
   * then hide or highlight it. The ad card is identified as the nearest
   * ancestor that is a large, visually distinct block — we use a combination
   * of offsetHeight threshold and depth cap.
   */
  function applyToAnchor(anchor, url, isShopify) {
    const card = findCardContainer(anchor);
    if (!card) return;

    // Avoid double-processing the same card for different links inside it
    if (card.getAttribute('data-sf-status') === 'shopify') return; // already confirmed Shopify
    if (card.getAttribute('data-sf-status') === 'hidden' && isShopify) {
      // Upgrade hidden → shopify (another link in this card is Shopify)
      showCard(card, url);
      return;
    }
    if (card.getAttribute('data-sf-status')) return; // already processed

    if (isShopify) {
      showCard(card, url);
    } else {
      hideCard(card);
    }
  }

  /**
   * Walk up from anchor, find the best "card" container.
   * 
   * Meta Ads Library wraps each ad in a div that:
   *  - is at least ~300px tall
   *  - has a border or background distinguishing it from siblings
   *  - typically 3–8 levels above the <a> tag
   * 
   * We walk up until we find a div whose NEXT SIBLING is also a similar-sized div
   * (i.e., we're at the list-item level, not the list-container level).
   */
  function findCardContainer(el) {
    let current = el;
    let best    = null;

    for (let depth = 0; depth < 20; depth++) {
      current = current.parentElement;
      if (!current || current === document.body) break;

      const h = current.offsetHeight;
      const w = current.offsetWidth;
      if (h < 200 || w < 200) continue;

      // Check if siblings look like peer ad cards (indicating we're at card level)
      const siblings = Array.from(current.parentElement?.children || [])
        .filter(s => s !== current && s.offsetHeight > 200);

      if (siblings.length >= 1) {
        best = current;
        // Keep walking up a little more to catch the full card wrapper
        if (depth >= 4) break;
      }
    }

    return best;
  }

  function hideCard(card) {
    card.setAttribute('data-sf-status', 'hidden');
    card.style.opacity    = '0.1';
    card.style.filter     = 'grayscale(1) blur(0.5px)';
    card.style.transition = 'opacity 0.2s, filter 0.2s';
  }

  function showCard(card, url) {
    card.setAttribute('data-sf-status', 'shopify');
    card.style.opacity      = '1';
    card.style.filter       = '';
    card.style.transition   = '';
    card.style.outline      = '2.5px solid #96bf48';
    card.style.borderRadius = '10px';
    card.style.boxShadow    = '0 0 0 4px rgba(150,191,72,0.15)';
  }

  function restoreAll() {
    document.querySelectorAll('[data-sf-status]').forEach(el => {
      el.removeAttribute('data-sf-status');
      el.style.opacity     = '';
      el.style.filter      = '';
      el.style.outline     = '';
      el.style.boxShadow   = '';
      el.style.transition  = '';
      el.style.borderRadius = '';
    });
  }

  // ── Observer (infinite scroll) ────────────────────────────────────────────────
  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (!isRunning) return;
      // Debounce: wait for the DOM burst to settle
      scheduleScan(800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Utils ─────────────────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log   = (...a) => console.log('[SF]', ...a);

  function sendStats() {
    chrome.runtime.sendMessage({ type: 'STATS_UPDATE', stats: { ...stats } }).catch(() => {});
  }
  function sendShopifyFound(url) {
    chrome.runtime.sendMessage({ type: 'SHOPIFY_FOUND', url }).catch(() => {});
  }

  log('v3 loaded');
  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
})();
