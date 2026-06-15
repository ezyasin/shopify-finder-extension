'use strict';

let allAds      = [];
let filteredAds = [];
let storeCount  = 0;

// ── Storage loading ────────────────────────────────────────────────────────────
// Use BOTH storage.onChanged (instant) AND polling (safety net).
// DO NOT use chrome.runtime.onMessage — it does not work reliably in tab pages.

function loadAds() {
  chrome.storage.local.get(['savedAds', 'shopifyUrls'], (result) => {
    if (chrome.runtime.lastError) {
      console.error('[Viewer] Storage read error:', chrome.runtime.lastError.message);
      updateBadge(0, 0);
      return;
    }
    const ads = result.savedAds;
    const urls = result.shopifyUrls;
    console.log('[Viewer] Storage read — savedAds:', ads ? ads.length : 'null/undefined', '| shopifyUrls:', urls ? urls.length : 'null/undefined');

    allAds = Array.isArray(ads) ? ads : [];
    const rawStoreUrls = Array.isArray(urls) ? urls : [];
    storeCount = rawStoreUrls.length;
    // Also compute displayable store count from savedAds as a fallback
    if (storeCount === 0 && allAds.length > 0) {
      const uniqueDomains = new Set(allAds.map(a => (a.shopifyUrl||'').replace(/^https?:\/\/(www\.)?/,'').split('/')[0]).filter(Boolean));
      storeCount = uniqueDomains.size;
    }
    applyFilters();
  });
}

// Instant update via storage change events
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('savedAds' in changes || 'shopifyUrls' in changes) {
    chrome.storage.local.get(['savedAds', 'shopifyUrls'], (result) => {
      const newVal = changes.savedAds ? changes.savedAds.newValue : result.savedAds;
      const newUrls = changes.shopifyUrls ? changes.shopifyUrls.newValue : result.shopifyUrls;
      console.log('[Viewer] storage.onChanged — savedAds:', newVal ? newVal.length : 0, '| shopifyUrls:', newUrls ? newUrls.length : 0);
      allAds = Array.isArray(newVal) ? newVal : [];
      const rawStoreUrls = Array.isArray(newUrls) ? newUrls : [];
      storeCount = rawStoreUrls.length;
      if (storeCount === 0 && allAds.length > 0) {
        const uniqueDomains = new Set(allAds.map(a => (a.shopifyUrl||'').replace(/^https?:\/\/(www\.)?/,'').split('/')[0]).filter(Boolean));
        storeCount = uniqueDomains.size;
      }
      applyFilters();
    });
  }
});

// ── Filters ────────────────────────────────────────────────────────────────────
function applyFilters() {
  const q     = document.getElementById('search').value.toLowerCase().trim();
  const sort  = document.getElementById('sort-sel').value;
  const media = document.getElementById('media-sel').value;

  let ads = [...allAds];
  if (q) {
    ads = ads.filter(a =>
      (a.advertiserName || '').toLowerCase().includes(q) ||
      (a.adText         || '').toLowerCase().includes(q) ||
      (a.shopifyUrl     || '').toLowerCase().includes(q)
    );
  }
  if (media === 'images')  ads = ads.filter(a => (a.images  || []).length > 0);
  if (media === 'videos')  ads = ads.filter(a => (a.videos  || []).length > 0);
  if (media === 'nomedia') ads = ads.filter(a => !(a.images || []).length && !(a.videos || []).length);
  if (sort === 'newest') ads.sort((a,b) => new Date(b.scrapedAt||0) - new Date(a.scrapedAt||0));
  if (sort === 'oldest') ads.sort((a,b) => new Date(a.scrapedAt||0) - new Date(b.scrapedAt||0));
  if (sort === 'name')   ads.sort((a,b) => (a.advertiserName||'').localeCompare(b.advertiserName||''));
  if (sort === 'media')  ads.sort((a,b) => ((b.images||[]).length+(b.videos||[]).length) - ((a.images||[]).length+(a.videos||[]).length));

  filteredAds = ads;
  render();
}

document.getElementById('search').addEventListener('input', applyFilters);
document.getElementById('sort-sel').addEventListener('change', applyFilters);
document.getElementById('media-sel').addEventListener('change', applyFilters);

// ── Render ─────────────────────────────────────────────────────────────────────
function updateBadge(n, stores) {
  const storesStr = stores !== undefined ? stores : storeCount;
  if (storesStr > 0 && n > storesStr) {
    document.getElementById('count-badge').textContent = `${storesStr} store${storesStr !== 1 ? 's' : ''} · ${n} ad${n !== 1 ? 's' : ''}`;
  } else {
    document.getElementById('count-badge').textContent = `${n} Shopify Ad${n !== 1 ? 's' : ''}`;
  }
}

function render() {
  const grid  = document.getElementById('grid');
  const empty = document.getElementById('empty');
  updateBadge(allAds.length, storeCount);

  if (filteredAds.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = filteredAds.map((ad, i) => buildCard(ad, i)).join('');

  // Safe click binding via data-idx
  grid.querySelectorAll('.ad-card[data-idx]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      openModal(filteredAds[parseInt(el.dataset.idx, 10)]);
    });
  });
  grid.querySelectorAll('video[data-hover-preview]').forEach(video => {
    video.addEventListener('mouseenter', () => video.play().catch(() => {}));
    video.addEventListener('mouseleave', () => {
      video.pause();
      video.currentTime = 0;
    });
  });
}

function buildCard(ad, i) {
  try {
    if (!ad || typeof ad !== 'object') throw new Error('Invalid ad');
  } catch {
    return '';
  }
  const domain  = (ad.shopifyUrl||'').replace(/^https?:\/\/(www\.)?/,'').split('/')[0];
  const hasImg  = (ad.images||[]).length > 0;
  const hasVid  = (ad.videos||[]).length > 0;
  const initial = ((ad.advertiserName||'?')[0]||'?').toUpperCase();

  let mediaTpl = `<div class="no-media"><span>🖼</span><span>NO MEDIA</span></div>`;
  if (hasVid) {
    mediaTpl = `<video src="${esc(ad.videos[0])}" muted playsinline preload="metadata" data-hover-preview
                  poster="${hasImg ? esc(ad.images[0]) : ''}"></video>
                <span class="vid-badge">▶ VIDEO</span>
                ${ad.videos.length > 1 ? `<span class="cnt-badge">+${ad.videos.length-1} more</span>` : ''}`;
  } else if (hasImg) {
    mediaTpl = `<img src="${esc(ad.images[0])}" alt="Ad" loading="lazy"/>
                ${ad.images.length > 1 ? `<span class="cnt-badge">${ad.images.length} imgs</span>` : ''}`;
  }

  const avatarTpl = ad.advertiserLogo
    ? `<img src="${esc(ad.advertiserLogo)}" alt="" loading="lazy"/>`
    : initial;

  return `<div class="ad-card" data-idx="${i}">
  <div class="ad-media">${mediaTpl}<span class="shopify-tag">SHOPIFY</span></div>
  <div class="ad-body">
    <div class="ad-adv">
      <div class="ad-avatar">${avatarTpl}</div>
      <div>
        <div class="adv-name">${esc(ad.advertiserName || 'Unknown Advertiser')}</div>
        <div class="adv-sub">Sponsored · Shopify</div>
      </div>
    </div>
    ${ad.adText ? `<div class="ad-text">${esc(ad.adText)}</div>` : '<div class="ad-text" style="color:var(--muted);font-style:italic">No ad text</div>'}
  </div>
  <div class="ad-footer">
    <span class="ad-domain" title="${esc(domain)}">${esc(domain)}</span>
    <a class="btn-visit" href="${esc(ad.shopifyUrl||'#')}" target="_blank" rel="noopener">↗ Visit Store</a>
  </div>
</div>`;
}

// ── Modal ──────────────────────────────────────────────────────────────────────
function openModal(ad) {
  document.getElementById('modal-title').textContent = ad.advertiserName || 'Ad Detail';
  const body   = document.getElementById('modal-body');
  const domain = (ad.shopifyUrl||'').replace(/^https?:\/\/(www\.)?/,'').split('/')[0];

  // Clear
  while (body.firstChild) body.removeChild(body.firstChild);

  // Media
  const hasImg = (ad.images||[]).length > 0;
  const hasVid = (ad.videos||[]).length > 0;
  if (hasImg || hasVid) {
    const mg = document.createElement('div');
    mg.className = 'media-grid';
    (ad.videos||[]).forEach(src => {
      const item = document.createElement('div'); item.className = 'media-item';
      const v = document.createElement('video'); v.src=src; v.controls=true; v.muted=true; v.playsInline=true; v.style.cssText='width:100%;height:100%;object-fit:cover';
      const dl = document.createElement('a'); dl.href=src; dl.target='_blank'; dl.rel='noopener'; dl.textContent='⬇ DL'; dl.className='media-dl';
      item.appendChild(v); item.appendChild(dl); mg.appendChild(item);
    });
    (ad.images||[]).forEach(src => {
      const item = document.createElement('div'); item.className = 'media-item';
      const img = document.createElement('img'); img.src=src; img.alt='Ad media'; img.loading='lazy';
      const dl = document.createElement('a'); dl.href=src; dl.target='_blank'; dl.rel='noopener'; dl.textContent='⬇ DL'; dl.className='media-dl';
      item.appendChild(img); item.appendChild(dl); mg.appendChild(item);
    });
    body.appendChild(mg);
  }

  // Ad copy
  const s1 = el('div','msec'); s1.innerHTML = `<h3>Ad Copy</h3><p>${esc(ad.adText || '(no text extracted)')}</p>`; body.appendChild(s1);

  // Info
  const s2 = el('div','msec');
  s2.innerHTML = `<h3>Info</h3><div class="info-grid">
    <div class="info-item"><div class="info-lbl">Advertiser</div><div class="info-val">${esc(ad.advertiserName||'—')}</div></div>
    <div class="info-item"><div class="info-lbl">Library Code</div><div class="info-val">${esc(ad.libraryCode||'—')}</div></div>
    <div class="info-item"><div class="info-lbl">Domain</div><div class="info-val">${esc(domain)}</div></div>
    <div class="info-item"><div class="info-lbl">Saved At</div><div class="info-val">${ad.scrapedAt ? new Date(ad.scrapedAt).toLocaleString() : '—'}</div></div>
    <div class="info-item"><div class="info-lbl">Images</div><div class="info-val">${(ad.images||[]).length}</div></div>
    <div class="info-item"><div class="info-lbl">Videos</div><div class="info-val">${(ad.videos||[]).length}</div></div>
  </div>`;
  body.appendChild(s2);

  // Link
  const s3 = el('div','msec');
  const h3 = el('h3'); h3.textContent = 'Store Link'; s3.appendChild(h3);
  const a = el('a'); a.href = ad.shopifyUrl||'#'; a.target='_blank'; a.rel='noopener'; a.textContent = ad.shopifyUrl||'—'; s3.appendChild(a);
  body.appendChild(s3);

  document.getElementById('overlay').classList.add('open');
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className=cls; return e; }

document.getElementById('modal-close').addEventListener('click', () => document.getElementById('overlay').classList.remove('open'));
document.getElementById('overlay').addEventListener('click', e => { if (e.target===e.currentTarget) e.currentTarget.classList.remove('open'); });
document.addEventListener('keydown', e => { if (e.key==='Escape') document.getElementById('overlay').classList.remove('open'); });

// ── Clear ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm(`Delete all ${allAds.length} saved ads?`)) return;
  chrome.storage.local.remove(['savedAds'], () => {
    allAds=[]; filteredAds=[]; render(); toast('All ads cleared');
  });
});

// ── CSV ────────────────────────────────────────────────────────────────────────
document.getElementById('btn-csv').addEventListener('click', () => {
  if (!filteredAds.length) { toast('No ads to export'); return; }
  const date = new Date().toISOString().split('T')[0];
  const cols = ['#','Advertiser','Domain','Library Code','Ad Text','Images','Videos','Saved At','Store URL'];
  const rows = filteredAds.map((ad,i) => [
    i+1, ad.advertiserName||'',
    (ad.shopifyUrl||'').replace(/^https?:\/\/(www\.)?/,'').split('/')[0],
    ad.libraryCode||'',
    (ad.adText||'').replace(/\n/g,' ').substring(0,400),
    (ad.images||[]).join(' | '), (ad.videos||[]).join(' | '),
    ad.scrapedAt ? new Date(ad.scrapedAt).toLocaleString() : '',
    ad.shopifyUrl||''
  ]);
  const csv = [cols,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  dlBlob(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}),`shopify-ads-${date}.csv`);
  toast('CSV downloaded!');
});

// ── Excel ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-excel').addEventListener('click', () => {
  if (!filteredAds.length) { toast('No ads to export'); return; }
  if (typeof JSZip === 'undefined') { document.getElementById('btn-csv').click(); return; }
  const date = new Date().toISOString().split('T')[0];
  const rows = [
    ['#','Advertiser','Domain','Library Code','Ad Text','Images','Videos','Saved At','Store URL'],
    ...filteredAds.map((ad,i) => [
      i+1, ad.advertiserName||'',
      (ad.shopifyUrl||'').replace(/^https?:\/\/(www\.)?/,'').split('/')[0],
      ad.libraryCode||'', (ad.adText||'').substring(0,400),
      (ad.images||[]).join(' | '), (ad.videos||[]).join(' | '),
      ad.scrapedAt ? new Date(ad.scrapedAt).toLocaleString() : '',
      ad.shopifyUrl||''
    ])
  ];
  const sheetRows = rows.map((r,ri)=>`<row r="${ri+1}">${r.map((v,ci)=>{
    const ref=String.fromCharCode(65+ci)+(ri+1);
    return typeof v==='number'?`<c r="${ref}"><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"><is><t>${xe(String(v))}</t></is></c>`;
  }).join('')}</row>`).join('');
  const ns='http://schemas.openxmlformats.org/';
  const zip=new JSZip();
  zip.file('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}package/2006/content-types"><Default Extension="rels" ContentType="${ns}package/2006/relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file('_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets><sheet name="Shopify Ads" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
  zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
     .then(blob=>{dlBlob(blob,`shopify-ads-${date}.xlsx`);toast('Excel downloaded!');});
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function dlBlob(blob, name) {
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),8000);
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function xe(s){return esc(s).replace(/'/g,'&apos;');}
let _tt;
function toast(msg){const e=document.getElementById('toast');e.textContent=msg;e.classList.add('show');clearTimeout(_tt);_tt=setTimeout(()=>e.classList.remove('show'),2800);}

// ── Boot ───────────────────────────────────────────────────────────────────────
// Load immediately on page open
loadAds();
// Poll every 2s as safety net (handles cases where storage.onChanged doesn't fire)
setInterval(loadAds, 2000);
