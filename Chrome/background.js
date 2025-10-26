// background.js

////////////////////////////
// Status helper -> popup //
////////////////////////////
function sendStatus({ text, error = false, done = false }) {
  try {
    chrome.runtime.sendMessage(
      {
        type: 'CATALOG_STATUS',
        text,
        error,
        done
      },
      () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          // popup not open -> ignore
        }
      }
    );
  } catch (e) {
    // ignore
  }
}

/////////////////////////////////////////
// Fetch .csv.gz and gunzip it
/////////////////////////////////////////

async function gunzipToText(gzUint8) {
  const ds = new DecompressionStream('gzip');
  const blob = new Blob([gzUint8]);
  const stream = blob.stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8').decode(buf);
}

async function fetchGzCsv(urlBase) {
  const ts = Date.now();
  const url = `${urlBase}?${ts}=`;

  const resp = await fetch(url);
  if (!resp) throw new Error('No response from ' + urlBase);
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' while fetching ' + urlBase);

  const arrBuf = await resp.arrayBuffer();
  const u8 = new Uint8Array(arrBuf);
  const csvText = await gunzipToText(u8);
  return csvText;
}

/////////////////////////
// CSV parser
/////////////////////////
function parseCsvBasic(csvText) {
  const lines = csvText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) return [];
  const header = lines[0].split(',').map(h => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const obj = {};
    for (let h = 0; h < header.length; h++) {
      obj[header[h]] = (cols[h] || '').trim();
    }
    rows.push(obj);
  }
  return rows;
}

///////////////////////////////////////
// Catalog build
///////////////////////////////////////
function buildThemeMap(themeRows) {
  const map = {};
  for (const t of themeRows) {
    map[t.id] = t.name;
  }
  return map;
}

function buildCatalog(setsRows, themesRows) {
  const themeMap = buildThemeMap(themesRows);
  const out = {};

  for (const s of setsRows) {
    const setNum = s.set_num || '';
    const officialId = (setNum.split('-')[0] || '').trim();
    if (!officialId) continue;

    const entry = {
      name: s.name || '',
      year: s.year || '',
      imageUrl: s.img_url || s.set_img_url || '',
      setNum,
      officialId,
      themeName: themeMap[s.theme_id] || ''
    };

    out[officialId] = entry;
  }
  return out;
}

/////////////////////////////////////////
// Refresh Lego catalog
/////////////////////////////////////////
async function refreshCatalog() {
  const SETS_GZ_URL   = "https://cdn.rebrickable.com/media/downloads/sets.csv.gz";
  const THEMES_GZ_URL = "https://cdn.rebrickable.com/media/downloads/themes.csv.gz";

  sendStatus({ text: 'Downloading sets.csv.gz…' });
  const setsCsvText = await fetchGzCsv(SETS_GZ_URL);

  sendStatus({ text: 'Downloading themes.csv.gz…' });
  const themesCsvText = await fetchGzCsv(THEMES_GZ_URL);

  sendStatus({ text: 'Parsing CSV…' });
  const setsRows = parseCsvBasic(setsCsvText);
  const themesRows = parseCsvBasic(themesCsvText);

  sendStatus({ text: 'Building catalog…' });
  const catalog = buildCatalog(setsRows, themesRows);

  await chrome.storage.local.set({
    CATALOG_DATA: catalog,
    CATALOG_LAST_UPDATED: Date.now()
  });

  sendStatus({ text: '✅ Done. Lego catalog saved.', done: true });
}

/////////////////////////////////////////
// Helpers for sync of Marstoy cache
/////////////////////////////////////////

// Convert "M12345" -> "54321" reversed
function toOfficialIdFromStoreId(storeId) {
  if (!storeId) return "";
  const norm = storeId.toUpperCase().trim();
  const body = norm.slice(1);
  return body.split("").reverse().join("");
}

// Strip HTML tags like <span>...</span> out of a string
function stripHtmlTags(str) {
  return str.replace(/<[^>]*>/g, "").trim();
}

// Extract all product cards from one HTML page string.
// No DOMParser: use regex to find <a ...href="/products/...">...</a> blocks.
// Returns { products: [...], done: boolean }
async function scrapeBrickKitsPage(pageNum) {
  const url = `https://marstoy.com/collections/brick-kits?page_num=${pageNum}`;

  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) {
    // If the page is not OK (404 etc), assume we're past the end
    return { products: [], done: true };
  }

  const html = await resp.text();

  // We'll collect possible product links like:
  // <a ... href="/products/m12345-some-title" ...> ...title text... </a>
  //
  // We do a global regex for <a ... href="/products/...">...</a>
  // and then we later dedupe by href.
  const linkRegex = /<a\b[^>]*href="([^"]*\/products\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  const seenHrefs = new Set();
  const products = [];

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1] || "";
    let innerHtml = match[2] || "";

    if (!href.includes("/products/")) continue;
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);

    // Extract storeId (M12345 / N12345) from href
    // e.g. /products/m12345-some-title
    let storeId = null;
    const m1 = href.match(/\/products\/.*?([mn]\d+)/i);
    if (m1) {
      storeId = m1[1].toUpperCase();
    } else {
      const m2 = href.match(/([mn]\d+)/i);
      if (m2) {
        storeId = m2[1].toUpperCase();
      }
    }

    // Clean up link text to get visible product name.
    // Remove tags inside <a> ... we only want readable product title-ish text.
    const shopName = stripHtmlTags(innerHtml);

    // Build absolute URL
    let absoluteUrl = href;
    if (absoluteUrl.startsWith("/")) {
      absoluteUrl = "https://marstoy.com" + absoluteUrl;
    }

    products.push({
      storeId: storeId || "",
      shopName: shopName || "",
      url: absoluteUrl
    });
  }

  // If we found zero products on this page, treat that as "stop".
  const done = products.length === 0;
  return { products, done };
}

// Walk all pages, enrich with Lego catalog data, save ALL_BRICK_KITS
async function syncBrickKitsCollection() {
  sendStatus({ text: 'Syncing Marstoy cache…' });

  // Get catalog so we can attach theme/year/name
  const { CATALOG_DATA } = await chrome.storage.local.get(["CATALOG_DATA"]);
  const catalog = CATALOG_DATA || {};

  const finalList = [];
  let pageNum = 1;

  while (true) {
    sendStatus({ text: `Syncing page ${pageNum}…` });

    const { products, done } = await scrapeBrickKitsPage(pageNum);
    if (done) break;

    for (const p of products) {
      const storeId = p.storeId || "";
      const officialId = toOfficialIdFromStoreId(storeId); // "LEGO set number" derived
      const catEntry = officialId ? catalog[officialId] : null;

      finalList.push({
        officialId: officialId || "",
        storeId: storeId || "",
        name: (catEntry && catEntry.name) || p.shopName || "",
        year: (catEntry && catEntry.year) || "",
        themeName: (catEntry && catEntry.themeName) || "",
        url: p.url || ""
      });
    }

    pageNum++;
    if (pageNum > 200) break; // safety stop
  }

  await chrome.storage.local.set({
    ALL_BRICK_KITS: finalList,
    ALL_BRICK_KITS_LAST_SYNC: Date.now()
  });

  sendStatus({ text: `✅ Synced ${finalList.length} products.`, done: true });
}

/////////////////////////////////////////
// Message handlers
/////////////////////////////////////////

function handleLookup(officialId, sendResponse) {
  chrome.storage.local.get(['CATALOG_DATA'], (res) => {
    const cat = res.CATALOG_DATA || {};
    const entry = cat[officialId] || null;
    sendResponse({ entry });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'REFRESH_CATALOG') {
    (async () => {
      try {
        await refreshCatalog();
      } catch (err) {
        console.error('Catalog refresh failed:', err);
        sendStatus({
          text: '❌ Catalog update failed: ' + (err && err.message ? err.message : err),
          error: true,
          done: true
        });
      }
    })();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'SYNC_COLLECTION') {
    (async () => {
      try {
        await syncBrickKitsCollection();
      } catch (err) {
        console.error('Sync collection failed:', err);
        sendStatus({
          text: '❌ Cache sync failed: ' + (err && err.message ? err.message : err),
          error: true,
          done: true
        });
      }
    })();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'LOOKUP_SET') {
    handleLookup(msg.officialId, sendResponse);
    return true; // keep sendResponse async
  }
});

/////////////////////////////////////////
// On install: auto refresh Lego catalog
/////////////////////////////////////////
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    if (details.reason === "install") {
      await refreshCatalog();
    }
    // optional:
    // await syncBrickKitsCollection();
  } catch (err) {
    console.error("Initial catalog fetch failed:", err);
    sendStatus({
      text: '❌ Initial catalog fetch failed: ' + (err && err.message ? err.message : err),
      error: true,
      done: true
    });
  }
});

/////////////////////////////////////////
// Toolbar click injects content.js and runs convert
/////////////////////////////////////////
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab || !tab.id) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { action: "convert" });
  } catch (e) {
    console.error("Manual convert failed:", e);
  }
});
