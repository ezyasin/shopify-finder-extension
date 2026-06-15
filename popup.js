// popup.js — Shopify Finder v7
'use strict';

const $ = id => document.getElementById(id);
const statusBadge  = $('status-badge');
const statShopify  = $('stat-shopify');
const statScanned  = $('stat-scanned');
const statHidden   = $('stat-hidden');
const progressWrap = $('progress-wrap');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const btnStart     = $('btn-start');
const btnStop      = $('btn-stop');
const btnCsv       = $('btn-csv');
const btnExcel     = $('btn-excel');
const btnClear     = $('btn-clear');
const btnViewer    = $('btn-viewer');
const toggleScroll = $('toggle-scroll');
const resultsList  = $('results-list');
const footerNote   = $('footer-note');
const mainUi       = $('main-ui');
const notOnPage    = $('not-on-page');
const scrollDone   = $('scroll-done');
const adsCollected = $('ads-collected');

let shopifyUrls = [];
let isRunning   = false;
let activeTabId = null;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('facebook.com/ads/library')) {
    mainUi.style.display    = 'none';
    notOnPage.style.display = 'block';
    return;
  }
  activeTabId = tab.id;

  // Load ALL state from storage — this is the source of truth, not in-memory
  syncFromStorage();

  toggleScroll.checked = true; // default on
  chrome.storage.local.get(['autoScroll', 'isRunning'], r => {
    if (r.autoScroll === false) toggleScroll.checked = false;
    if (r.isRunning) setRunning(true);
  });

  footerNote.textContent = tab.url.replace('https://www.facebook.com','').split('?')[0];
}

// ── Sync all UI from storage (called on open and on storage changes) ──────────
function syncFromStorage() {
  chrome.storage.local.get(['shopifyUrls','stats','savedAds'], r => {
    shopifyUrls = Array.isArray(r.shopifyUrls) ? r.shopifyUrls : [];
    renderResults();
    updateExportBtns();
    if (r.stats) updateStats(r.stats);
    updateAdsCollected(Array.isArray(r.savedAds) ? r.savedAds.length : 0);
  });
}

// Listen to storage changes — if content script writes while popup is open, sync
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.shopifyUrls) {
    shopifyUrls = changes.shopifyUrls.newValue || [];
    renderResults();
    updateExportBtns();
  }
  if (changes.savedAds) {
    updateAdsCollected((changes.savedAds.newValue || []).length);
  }
});

// ── Messages from content script (live UI updates while popup is open) ────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATS_UPDATE') {
    updateStats(msg.stats);
    chrome.storage.local.set({ stats: msg.stats });
    if (isRunning) {
      const n = msg.stats.scanned || 0;
      progressText.textContent = `${n} scanned`;
      progressFill.style.width = Math.min(96, 8 + n * 2) + '%';
    }
  }
  if (msg.type === 'AD_COLLECTED') {
    updateAdsCollected(msg.total);
  }
  if (msg.type === 'SCROLL_DONE') {
    scrollDone.style.display = 'inline';
    setTimeout(() => { scrollDone.style.display = 'none'; }, 4000);
  }
  // SHOPIFY_FOUND is now handled via storage.onChanged above — no need here
});

// ── Scroll toggle ─────────────────────────────────────────────────────────────
toggleScroll.addEventListener('change', () => {
  const val = toggleScroll.checked;
  chrome.storage.local.set({ autoScroll: val });
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, { type: 'SET_SCROLL', value: val }).catch(() => {});
});

// ── Buttons ───────────────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  if (!activeTabId) return;
  const withScroll = toggleScroll.checked;
  chrome.storage.local.set({ autoScroll: withScroll, isRunning: true });
  setRunning(true);
  scrollDone.style.display = 'none';

  const sendStart = () => {
    chrome.tabs.sendMessage(activeTabId, { type: 'START_SCAN', autoScroll: withScroll }, (resp) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ['content.js'] }, () => {
          if (chrome.runtime.lastError) { setRunning(false); return; }
          setTimeout(sendStart, 400);
        });
      }
    });
  };
  sendStart();
});

btnStop.addEventListener('click', () => {
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, { type: 'STOP_SCAN' }).catch(() => {});
  setRunning(false);
  chrome.storage.local.set({ isRunning: false });
});

btnViewer.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

// Export from popup uses shopifyUrls (URLs only)
btnCsv.addEventListener('click',   () => shopifyUrls.length && exportCSV());
btnExcel.addEventListener('click', () => shopifyUrls.length && exportExcel());

btnClear.addEventListener('click', () => {
  chrome.storage.local.remove(['shopifyUrls','stats','savedAds','isRunning'], () => {
    shopifyUrls = [];
    renderResults();
    updateStats({ shopify:0, scanned:0, hidden:0 });
    updateExportBtns();
    updateAdsCollected(0);
    setRunning(false);
  });
});

// ── UI helpers ────────────────────────────────────────────────────────────────
function setRunning(on) {
  isRunning = on;
  if (on) {
    statusBadge.textContent = 'RUNNING';
    statusBadge.className   = 'status-badge running';
    btnStart.disabled = true;
    btnStop.disabled  = false;
    progressWrap.classList.add('visible');
  } else {
    statusBadge.textContent = shopifyUrls.length ? 'STOPPED' : 'IDLE';
    statusBadge.className   = `status-badge ${shopifyUrls.length ? 'stopped' : 'idle'}`;
    btnStart.disabled = false;
    btnStop.disabled  = true;
    progressWrap.classList.remove('visible');
    progressFill.style.width = '0%';
    progressText.textContent = '0%';
  }
}

function updateStats(s) {
  statShopify.textContent = s.shopify || 0;
  statScanned.textContent = s.scanned || 0;
  statHidden.textContent  = s.hidden  || 0;
}

function updateAdsCollected(n) {
  adsCollected.textContent   = n > 0 ? `${n} saved` : '';
  adsCollected.style.display = n > 0 ? 'inline' : 'none';
}

function renderResults() {
  const heading = document.querySelector('.results-label');
  if (!shopifyUrls.length) {
    resultsList.innerHTML = `<div class="empty-state"><span class="icon">🔍</span>Run a scan to find Shopify stores</div>`;
    if (heading) heading.textContent = 'Found Shopify Sites';
    return;
  }
  if (heading) heading.textContent = `Found Shopify Sites (${shopifyUrls.length})`;
  resultsList.innerHTML = shopifyUrls.map(url => {
    const d = url.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'');
    return `<div class="result-item" title="${url}"><div class="result-dot"></div><div class="result-url">${h(d)}</div></div>`;
  }).join('');
}

function updateExportBtns() {
  btnCsv.disabled   = shopifyUrls.length === 0;
  btnExcel.disabled = shopifyUrls.length === 0;
}

const h  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const xe = s => h(s).replace(/'/g,'&apos;');

// ── CSV export (uses savedAds for rich data, falls back to shopifyUrls) ──────
function exportCSV() {
  const date = new Date().toISOString().split('T')[0];
  chrome.storage.local.get(['savedAds'], (r) => {
    const savedAds = Array.isArray(r.savedAds) ? r.savedAds : [];
    let rows;
    if (savedAds.length > 0) {
      const cols = ['#','Advertiser','Domain','Library Code','Ad Text','Images','Videos','Saved At','Store URL'];
      rows = [cols, ...savedAds.map((ad,i) => [
        i+1, ad.advertiserName||'',
        (ad.shopifyUrl||'').replace(/^https?:\/\/(www\.)?/,'').split('/')[0],
        ad.libraryCode||'',
        (ad.adText||'').replace(/\n/g,' ').substring(0,400),
        (ad.images||[]).join(' | '), (ad.videos||[]).join(' | '),
        ad.scrapedAt ? new Date(ad.scrapedAt).toLocaleString() : '',
        ad.shopifyUrl||''
      ])];
    } else {
      rows = [['#','URL','Domain','Scan Date'],
        ...shopifyUrls.map((url,i) => [i+1, url, url.replace(/^https?:\/\/(www\.)?/,'').split('/')[0], date])];
    }
    const csv = rows.map(r => r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    dl(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}), `shopify-stores-${date}.csv`);
  });
}

// ── Excel export ──────────────────────────────────────────────────────────────
function exportExcel() {
  if (typeof JSZip === 'undefined') { exportCSV(); return; }
  const date = new Date().toISOString().split('T')[0];
  chrome.storage.local.get(['savedAds'], (r) => {
    const savedAds = Array.isArray(r.savedAds) ? r.savedAds : [];
    let rows;
    if (savedAds.length > 0) {
      rows = [
        ['#','Advertiser','Domain','Library Code','Ad Text','Images','Videos','Saved At','Store URL'],
        ...savedAds.map((ad,i) => [
          i+1, ad.advertiserName||'',
          (ad.shopifyUrl||'').replace(/^https?:\/\/(www\.)?/,'').split('/')[0],
          ad.libraryCode||'', (ad.adText||'').substring(0,400),
          (ad.images||[]).join(' | '), (ad.videos||[]).join(' | '),
          ad.scrapedAt ? new Date(ad.scrapedAt).toLocaleString() : '',
          ad.shopifyUrl||''
        ])
      ];
    } else {
      rows = [['#','URL','Domain','Scan Date'],
        ...shopifyUrls.map((url,i) => [i+1, url, url.replace(/^https?:\/\/(www\.)?/,'').split('/')[0], date])];
    }
    const sheetRows = rows.map((r,ri) => `<row r="${ri+1}">${r.map((v,ci)=>{
      const ref=String.fromCharCode(65+ci)+(ri+1);
      return typeof v==='number'?`<c r="${ref}"><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"><is><t>${xe(String(v))}</t></is></c>`;
    }).join('')}</row>`).join('');
    const ns='http://schemas.openxmlformats.org/';
    const zip=new JSZip();
    zip.file('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}package/2006/content-types"><Default Extension="rels" ContentType="${ns}package/2006/relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
    zip.file('_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file('xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
    zip.file('xl/worksheets/sheet1.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
    zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
       .then(blob=>dl(blob,`shopify-stores-${date}.xlsx`));
  });
}

function dl(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => setTimeout(()=>URL.revokeObjectURL(url),10000));
}

init();
