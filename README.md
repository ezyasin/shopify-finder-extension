# 🛍 Shopify Finder – Meta Ads Library

A Chrome extension that scans the Meta Ads Library, hides non-Shopify ads, highlights Shopify stores, and lets you export all found URLs to CSV or Excel.

---

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **"Load unpacked"**
4. Select the `shopify-finder-extension` folder
5. The extension icon will appear in your toolbar

---

## How to Use

1. Go to [Meta Ads Library](https://www.facebook.com/ads/library/)
2. Apply any filters you want (country, category, keywords, etc.)
3. Click the **Shopify Finder** extension icon in your toolbar
4. Click **▶ Start Scan**
5. The extension will:
   - Scan each ad card for Shopify fingerprints
   - **Hide** non-Shopify ads (greyed out)
   - **Highlight** Shopify stores with a green border
   - Show live counts: Shopify found / Total scanned / Hidden
6. Scroll down to load more ads — the extension auto-scans new content
7. Click **■ Stop** when done
8. Click **⬇ CSV** or **⬇ Excel (XLSX)** to download your results

---

## How Shopify Detection Works

The extension uses multiple techniques to identify Shopify stores:

| Method | Description |
|--------|-------------|
| Domain check | Detects `*.myshopify.com` domains instantly |
| HTML fingerprinting | Scans page source for `cdn.shopify.com`, `window.Shopify`, `ShopifyAnalytics`, etc. |
| Header detection | Checks for `x-shopify-stage` and related HTTP headers |
| Path probing | Tests `/cart.js` — a Shopify-exclusive API endpoint |

---

## Export Formats

- **CSV** — Simple comma-separated file with columns: `#`, `URL`, `Domain`, `Discovered On`
- **Excel (XLSX)** — Proper spreadsheet file, opens in Excel / Google Sheets

---

## Notes

- Meta may update their DOM structure — if scanning stops working, please check for extension updates
- The `https://*/*` host permission is required to fetch advertiser websites for Shopify detection
- No data is sent anywhere — everything stays in your browser
