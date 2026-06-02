// background.js — Service Worker v3
// Handles Shopify detection via fetch (no CORS) and message relay.

'use strict';

const domainCache = new Map(); // domain → true|false

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Shopify check — requested by content script
  if (msg.type === 'CHECK_SHOPIFY') {
    checkIsShopify(msg.url)
      .then(isShopify => sendResponse({ isShopify }))
      .catch(() => sendResponse({ isShopify: false }));
    return true; // keep channel open for async
  }

  // Stats / found — sent by content script, forward to popup ONLY
  // (Do NOT re-broadcast or we get an infinite loop)
  if (msg.type === 'STATS_UPDATE' || msg.type === 'SHOPIFY_FOUND' || msg.type === 'CONTENT_READY') {
    // Forward to popup if it's open (popup listens on chrome.runtime.onMessage)
    // We simply don't respond — the popup already listens to all runtime messages.
    // Nothing needed here; popup receives directly from content via the runtime bus.
    return false;
  }
});

// ── Detection ─────────────────────────────────────────────────────────────────
async function checkIsShopify(rawUrl) {
  let domain;
  try {
    domain = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return false; }

  if (domainCache.has(domain)) return domainCache.get(domain);

  // Instant: myshopify subdomain
  if (domain.endsWith('.myshopify.com')) {
    domainCache.set(domain, true);
    return true;
  }

  const origin = `https://${domain}`;

  // Run checks in parallel for speed
  const [cartResult, htmlResult, headerResult] = await Promise.allSettled([
    checkCartJs(origin),
    checkHomepageHtml(origin),
    checkHeaders(origin),
  ]);

  const isShopify =
    cartResult.value   === true ||
    htmlResult.value   === true ||
    headerResult.value === true;

  domainCache.set(domain, isShopify);
  console.log(`[SF BG] ${domain} → ${isShopify ? '✓ SHOPIFY' : '✗ not shopify'}`);
  return isShopify;
}

// /cart.js — Shopify-exclusive endpoint, fastest positive signal
async function checkCartJs(origin) {
  try {
    const resp = await fetch(`${origin}/cart.js`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!resp.ok) return false;
    const text = await resp.text();
    // Must contain Shopify cart shape
    return /["']item_count["']\s*:/.test(text) && /["']items["']\s*:/.test(text);
  } catch { return false; }
}

// Homepage HTML — scan for Shopify fingerprints
async function checkHomepageHtml(origin) {
  try {
    const resp = await fetch(origin, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
      headers: { 'Accept': 'text/html' }
    });
    if (!resp.ok) return false;

    // Stream first 100KB only
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let bytes = 0;
    while (bytes < 100_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
    }
    reader.cancel().catch(() => {});

    return isShopifyHtml(html);
  } catch { return false; }
}

// HTTP headers — some Shopify stores expose these
async function checkHeaders(origin) {
  try {
    const resp = await fetch(origin, {
      method: 'HEAD',
      signal: AbortSignal.timeout(6000),
      redirect: 'follow',
    });
    const SHOPIFY_HEADERS = [
      'x-shopify-stage', 'x-shopid', 'x-shardid',
      'x-shopify-request-id', 'x-shopify-shop-api-call-limit',
    ];
    for (const h of SHOPIFY_HEADERS) {
      if (resp.headers.get(h)) return true;
    }
    const powered = (resp.headers.get('x-powered-by') || '').toLowerCase();
    if (powered.includes('shopify')) return true;
    return false;
  } catch { return false; }
}

function isShopifyHtml(html) {
  const SIGNALS = [
    /cdn\.shopify\.com\//,          // CDN — most reliable
    /cdn\.shopifycloud\.com\//,     // CDN v2
    /window\.Shopify\s*[={]/,       // Global object
    /ShopifyAnalytics/,             // Analytics script
    /class=["'][^"']*shopify-section/, // Theme sections
    /myshopify\.com/,               // Internal reference
    /"shop_id"\s*:/,                // Config JSON
    /Shopify\.theme/,               // Theme object
    /data-shopify-/,                // Data attributes
    /\/cdn\/shop\//,                // CDN path pattern
    /Shopify\.PaymentButton/,       // Payment button
    /window\.ShopifyPayments/,      // Payments global
  ];
  return SIGNALS.some(re => re.test(html));
}

console.log('[SF BG] background.js v3 ready');
