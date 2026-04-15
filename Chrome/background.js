importScripts('shared.js', 'runtime.js');

const { MESSAGE_TYPES, STORAGE_KEYS, toOfficialId } = MarstoyShared;
const { storageGet, storageSet, sendRuntimeMessage } = MarstoyRuntime;

const REBRICKABLE_URLS = Object.freeze({
  sets: 'https://cdn.rebrickable.com/media/downloads/sets.csv.gz',
  themes: 'https://cdn.rebrickable.com/media/downloads/themes.csv.gz',
});

const MAX_SYNC_PAGES = 200;

function sendStatus({ text, error = false, done = false }) {
  sendRuntimeMessage({
    type: MESSAGE_TYPES.catalogStatus,
    text,
    error,
    done,
  });
}

async function gunzipToText(gzUint8) {
  const ds = new DecompressionStream('gzip');
  const blob = new Blob([gzUint8]);
  const stream = blob.stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8').decode(buf);
}

async function fetchGzCsv(urlBase) {
  const url = `${urlBase}?${Date.now()}=`;
  const resp = await fetch(url);

  if (!resp) throw new Error(`No response from ${urlBase}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} while fetching ${urlBase}`);

  return gunzipToText(new Uint8Array(await resp.arrayBuffer()));
}

function splitCsvLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cols.push(current.trim());
  return cols;
}

function parseCsvBasic(csvText) {
  const lines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);

  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]);

  return lines.slice(1).map(line => {
    const cols = splitCsvLine(line);
    const row = {};

    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = cols[i] || '';
    }

    return row;
  });
}

function buildThemeMap(themeRows) {
  const themeMap = {};
  for (const row of themeRows) {
    themeMap[row.id] = row.name;
  }
  return themeMap;
}

function buildCatalog(setsRows, themesRows) {
  const themeMap = buildThemeMap(themesRows);
  const catalog = {};

  for (const row of setsRows) {
    const setNum = row.set_num || '';
    const officialId = (setNum.split('-')[0] || '').trim();
    if (!officialId) continue;

    catalog[officialId] = {
      name: row.name || '',
      year: row.year || '',
      imageUrl: row.img_url || row.set_img_url || '',
      setNum,
      officialId,
      themeName: themeMap[row.theme_id] || '',
    };
  }

  return catalog;
}

async function refreshCatalog() {
  sendStatus({ text: 'Downloading sets.csv.gz…' });
  const setsCsvText = await fetchGzCsv(REBRICKABLE_URLS.sets);

  sendStatus({ text: 'Downloading themes.csv.gz…' });
  const themesCsvText = await fetchGzCsv(REBRICKABLE_URLS.themes);

  sendStatus({ text: 'Parsing CSV…' });
  const setsRows = parseCsvBasic(setsCsvText);
  const themesRows = parseCsvBasic(themesCsvText);

  sendStatus({ text: 'Building catalog…' });
  const catalog = buildCatalog(setsRows, themesRows);

  await storageSet({
    [STORAGE_KEYS.catalogData]: catalog,
    [STORAGE_KEYS.catalogLastUpdated]: Date.now(),
  });

  sendStatus({ text: '✅ Done. Lego catalog saved.', done: true });
}

function stripHtmlTags(str) {
  return str.replace(/<[^>]*>/g, '').trim();
}

function normalizeProductHref(href) {
  if (!href) return '';
  return href.startsWith('/') ? `https://marstoy.com${href}` : href;
}

function extractStoreIdFromHref(href) {
  const fromProductPath = href.match(/\/products\/.*?([mn]\d+)/i);
  if (fromProductPath) return fromProductPath[1].toUpperCase();

  const fromAnywhere = href.match(/([mn]\d+)/i);
  if (fromAnywhere) return fromAnywhere[1].toUpperCase();

  return '';
}

async function scrapeBrickKitsPage(pageNum) {
  const url = `https://marstoy.com/collections/brick-kits?page_num=${pageNum}`;
  const resp = await fetch(url, { credentials: 'include' });

  if (!resp.ok) {
    return { products: [], done: true };
  }

  const html = await resp.text();
  const linkRegex = /<a\b[^>]*href="([^"]*\/products\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seenHrefs = new Set();
  const products = [];

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1] || '';
    const innerHtml = match[2] || '';

    if (!href.includes('/products/') || seenHrefs.has(href)) continue;
    seenHrefs.add(href);

    products.push({
      storeId: extractStoreIdFromHref(href),
      shopName: stripHtmlTags(innerHtml),
      url: normalizeProductHref(href),
    });
  }

  return {
    products,
    done: products.length === 0,
  };
}

function buildBrickKitEntry(product, catalog) {
  const storeId = product.storeId || '';
  const officialId = toOfficialId(storeId);
  const catalogEntry = officialId ? catalog[officialId] : null;

  return {
    officialId: officialId || '',
    storeId,
    name: catalogEntry?.name || product.shopName || '',
    year: catalogEntry?.year || '',
    themeName: catalogEntry?.themeName || '',
    url: product.url || '',
  };
}

async function syncBrickKitsCollection() {
  sendStatus({ text: 'Syncing Marstoy cache…' });

  const catalog = (await storageGet([STORAGE_KEYS.catalogData]))[STORAGE_KEYS.catalogData] || {};
  const finalList = [];

  for (let pageNum = 1; pageNum <= MAX_SYNC_PAGES; pageNum += 1) {
    sendStatus({ text: `Syncing page ${pageNum}…` });

    const { products, done } = await scrapeBrickKitsPage(pageNum);
    if (done) break;

    for (const product of products) {
      finalList.push(buildBrickKitEntry(product, catalog));
    }
  }

  await storageSet({
    [STORAGE_KEYS.allBrickKits]: finalList,
    [STORAGE_KEYS.allBrickKitsLastSync]: Date.now(),
  });

  sendStatus({ text: `✅ Synced ${finalList.length} products.`, done: true });
}

function handleLookup(officialId, sendResponse) {
  storageGet([STORAGE_KEYS.catalogData]).then(res => {
    const catalog = res[STORAGE_KEYS.catalogData] || {};
    sendResponse({ entry: catalog[officialId] || null });
  });
}

async function runAction(action, failurePrefix) {
  try {
    await action();
  } catch (err) {
    console.error(failurePrefix, err);
    sendStatus({
      text: `❌ ${failurePrefix}: ${err && err.message ? err.message : err}`,
      error: true,
      done: true,
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === MESSAGE_TYPES.refreshCatalog) {
    runAction(refreshCatalog, 'Catalog update failed');
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === MESSAGE_TYPES.syncCollection) {
    runAction(syncBrickKitsCollection, 'Cache sync failed');
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === MESSAGE_TYPES.lookupSet) {
    handleLookup(msg.officialId, sendResponse);
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason !== 'install') return;

  try {
    await refreshCatalog();
  } catch (err) {
    console.error('Initial catalog fetch failed:', err);
    sendStatus({
      text: `❌ Initial catalog fetch failed: ${err && err.message ? err.message : err}`,
      error: true,
      done: true,
    });
  }
});
