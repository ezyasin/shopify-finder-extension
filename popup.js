// popup.js — Shopify Finder v3

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
const resultsList  = $('results-list');
const footerNote   = $('footer-note');
const mainUi       = $('main-ui');
const notOnPage    = $('not-on-page');

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

  // Restore persisted data
  const saved = await chrome.storage.local.get(['shopifyUrls', 'isRunning', 'stats']);
  shopifyUrls = saved.shopifyUrls || [];
  renderResults();
  updateExportBtns();
  if (saved.stats)     updateStats(saved.stats);
  if (saved.isRunning) setRunning(true);

  footerNote.textContent = tab.url.replace('https://www.facebook.com', '').split('?')[0];
}

// ── Message listener ──────────────────────────────────────────────────────────
// Content script messages arrive at chrome.runtime directly (same extension).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SHOPIFY_FOUND') {
    if (!shopifyUrls.includes(msg.url)) {
      shopifyUrls.push(msg.url);
      chrome.storage.local.set({ shopifyUrls });
      renderResults();
      updateExportBtns();
    }
  }
  if (msg.type === 'STATS_UPDATE') {
    updateStats(msg.stats);
    chrome.storage.local.set({ stats: msg.stats });
    // Drive progress bar from scanned count (open-ended scan)
    const n = msg.stats.scanned || 0;
    if (n > 0 && isRunning) {
      progressText.textContent = `${n} scanned`;
      // Animate fill width based on shopify ratio
      const ratio = n > 0 ? Math.min(1, (msg.stats.shopify || 0) / Math.max(n, 1)) : 0;
      progressFill.style.width = Math.max(8, Math.round(ratio * 100)) + '%';
    }
  }
});

// ── Button handlers ───────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  if (!activeTabId) return;
  setRunning(true);
  chrome.storage.local.set({ isRunning: true });

  // Send to content script; inject if not yet there
  chrome.tabs.sendMessage(activeTabId, { type: 'START_SCAN' }, (resp) => {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript(
        { target: { tabId: activeTabId }, files: ['content.js'] },
        () => {
          if (chrome.runtime.lastError) {
            console.error('Injection failed:', chrome.runtime.lastError.message);
            setRunning(false);
            return;
          }
          setTimeout(() => chrome.tabs.sendMessage(activeTabId, { type: 'START_SCAN' }), 300);
        }
      );
    }
  });
});

btnStop.addEventListener('click', () => {
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, { type: 'STOP_SCAN' }).catch(() => {});
  setRunning(false);
  chrome.storage.local.set({ isRunning: false });
});

btnCsv.addEventListener('click',   () => shopifyUrls.length && exportCSV());
btnExcel.addEventListener('click', () => shopifyUrls.length && exportExcel());

btnClear.addEventListener('click', () => {
  shopifyUrls = [];
  chrome.storage.local.remove(['shopifyUrls', 'stats']);
  renderResults();
  updateStats({ shopify: 0, scanned: 0, hidden: 0 });
  updateExportBtns();
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

function renderResults() {
  if (!shopifyUrls.length) {
    resultsList.innerHTML = `<div class="empty-state"><span class="icon">🔍</span>Run a scan to find Shopify stores</div>`;
    return;
  }
  resultsList.innerHTML = shopifyUrls.map(url => {
    const display = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    return `<div class="result-item" title="${url}"><div class="result-dot"></div><div class="result-url">${h(display)}</div></div>`;
  }).join('');
}

function updateExportBtns() {
  const has = shopifyUrls.length > 0;
  btnCsv.disabled   = !has;
  btnExcel.disabled = !has;
}

const h = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCSV() {
  const date = new Date().toISOString().split('T')[0];
  const rows = [
    ['#','URL','Domain','Scan Date'],
    ...shopifyUrls.map((url, i) => [
      i + 1, url,
      url.replace(/^https?:\/\/(www\.)?/,'').split('/')[0],
      date
    ])
  ];
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  download(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}), `shopify-stores-${date}.csv`);
}

// ── Excel export ──────────────────────────────────────────────────────────────
function exportExcel() {
  if (typeof JSZip === 'undefined') { exportCSV(); return; }

  const date = new Date().toISOString().split('T')[0];
  const rows = [
    ['#','URL','Domain','Scan Date'],
    ...shopifyUrls.map((url, i) => [
      i+1, url,
      url.replace(/^https?:\/\/(www\.)?/,'').split('/')[0],
      date
    ])
  ];

  const sheetRows = rows.map((row, ri) =>
    `<row r="${ri+1}">${row.map((val, ci) => {
      const ref = `${String.fromCharCode(65+ci)}${ri+1}`;
      return typeof val === 'number'
        ? `<c r="${ref}"><v>${val}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${xe(String(val))}</t></is></c>`;
    }).join('')}</row>`
  ).join('');

  const ns   = 'http://schemas.openxmlformats.org/';
  const nsss = ns + 'spreadsheetml/2006/main';
  const nsr  = ns + 'officeDocument/2006/relationships';
  const nspk = 'http://schemas.openxmlformats.org/package/2006/';

  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${nspk}content-types">
  <Default Extension="rels" ContentType="${nspk}relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${nspk}relationships">
  <Relationship Id="rId1" Type="${nsr}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${nsss}" xmlns:r="${nsr}">
  <sheets><sheet name="Shopify Stores" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);

  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${nspk}relationships">
  <Relationship Id="rId1" Type="${nsr}/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);

  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${nsss}"><sheetData>${sheetRows}</sheetData></worksheet>`);

  zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    .then(blob => download(blob, `shopify-stores-${date}.xlsx`))
    .catch(() => exportCSV());
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

function xe(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

init();
