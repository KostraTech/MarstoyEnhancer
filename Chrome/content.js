(function () {
  // ====== API KEY (loaded from chrome.storage.local) ======
  let API_KEY = null;
  let readyRanOnce = false; // to avoid double heavy runs

  function onApiKeyLoadedOrChanged(newKey) {
    const prev = API_KEY;
    API_KEY = (newKey || '').trim() || null;
    if (!prev && API_KEY) {
      // Key just became available -> (re)process page now
      determineAndProcessPage();
    }
    if (prev && !API_KEY) {
      // Key removed -> no fetches, but cached data still works
      logDebug('API key removed; network fetch will be skipped.');
    }
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['REBRICKABLE_API_KEY'], (res) => {
      onApiKeyLoadedOrChanged(res.REBRICKABLE_API_KEY || null);
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && 'REBRICKABLE_API_KEY' in changes) {
        onApiKeyLoadedOrChanged(changes.REBRICKABLE_API_KEY.newValue || null);
      }
    });
  }

  const debugMode = false;

  // ====== SETTINGS ======
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const DAILY_API_LIMIT = 900;                   // Adjust to your plan
  const INVALID_KEYWORDS = ["Plates", "Beams", "Bricks", "Miscellaneous"];

  // ====== RETRY / ANTI-STORM POLICY ======
  // Per-ID attempts during current page session (reset on F5/navigation):
  // 1st = immediately, 2nd = +2s, 3rd = +60s after 2nd, then stop
  const MAX_ATTEMPTS_PER_ID_PER_PAGE = 3;
  const RETRY_DELAYS_MS = [2000, 60000]; // before 2nd and 3rd attempts

  // ====== SESSION STATE ======
  let lockedProductId = null;         // Prevent product page overrides
  const inflight = new Map();         // id -> Promise (dedupe in-flight)
  const failState = new Map();        // id -> { attempts: number, lastAttemptAt: number }
  let globalQuotaExhausted = false;   // Stop further calls if our local DAILY_API_LIMIT is hit

  function logDebug(message, data = null) {
    if (debugMode) {
      const ts = new Date().toISOString();
      console.log(`[${ts}] ${message}`, data || '');
    }
  }

  // ====== STORAGE HELPERS ======
  function storageGet(keys) {
    return new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime.lastError) {
            logDebug('storage.get error:', chrome.runtime.lastError);
            resolve({});
          } else {
            resolve(result || {});
          }
        });
      } else {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set(obj, () => {
          if (chrome.runtime.lastError) {
            logDebug('storage.set error:', chrome.runtime.lastError);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ====== CACHE & QUOTA ======
  function cacheKey(id) { return (id || '').toUpperCase().trim(); }
  function quotaKey(dateStr) { return `QUOTA::${dateStr}`; }
  function getTodayStr() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }

  async function getCacheItem(productId) {
    const key = cacheKey(productId);
    const obj = await storageGet([key]);
    const item = obj[key];
    if (!item) return null;
    if (!item.ts || (Date.now() - item.ts) > CACHE_TTL_MS) return null;
    return item; // { name, imageUrl, setNum, officialId, year, ts }
  }

  async function setCacheItem(productId, data) {
    const key = cacheKey(productId);
    await storageSet({ [key]: { ...data, ts: Date.now() } });
  }

  async function takeQuotaIfAvailable() {
    const today = getTodayStr();
    const key = quotaKey(today);
    const obj = await storageGet([key]);
    const used = obj[key] || 0;
    if (used >= DAILY_API_LIMIT) return false;
    await storageSet({ [key]: used + 1 });
    return true;
  }

  // ====== FETCH (CACHE + IN-FLIGHT + RETRIES) ======
  async function fetchRebrickableData(productId) {
    const normalized = cacheKey(productId);

    if (globalQuotaExhausted) return null;

    // If API key not provided, skip network fetch but still allow cached items to work
    if (!API_KEY) {
      logDebug('API key not set; skipping fetch for', normalized);
      return null;
    }

    // Cache first
    const cached = await getCacheItem(normalized);
    if (cached) return cached;

    // Attempts state
    const fs = failState.get(normalized) || { attempts: 0, lastAttemptAt: 0 };
    if (fs.attempts >= MAX_ATTEMPTS_PER_ID_PER_PAGE) {
      logDebug(`ID ${normalized} reached max attempts this session; skipping until refresh.`);
      return null;
    }

    // Dedupe concurrent calls
    if (inflight.has(normalized)) return inflight.get(normalized);

    // Delay for 2nd/3rd attempts
    const delayMs = fs.attempts === 0 ? 0
      : (RETRY_DELAYS_MS[Math.min(fs.attempts - 1, RETRY_DELAYS_MS.length - 1)] || 0);

    const p = (async () => {
      if (delayMs > 0) await new Promise(res => setTimeout(res, delayMs));

      // Re-check cache after delay
      const cached2 = await getCacheItem(normalized);
      if (cached2) return cached2;

      // Local daily quota
      const ok = await takeQuotaIfAvailable();
      if (!ok) {
        globalQuotaExhausted = true;
        logDebug('Local daily quota exhausted; stopping further calls this session.');
        return null;
      }

      // Build Rebrickable URL: strip leading M/N, reverse digits, add -1
      const reversedId = normalized.slice(1).split('').reverse().join('');
      const url = `https://rebrickable.com/api/v3/lego/sets/${reversedId}-1/`;
      logDebug(`Fetching ${normalized} → ${url}`);

      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `key ${API_KEY}`
          }
        });

        if (!resp.ok) {
          incrementFail(normalized);
          return null;
        }

        const data = await resp.json();
        if (!data?.name) {
          incrementFail(normalized);
          return null;
        }

        // Success
        const setNum = data.set_num || '';
        const officialId = (setNum.split('-')[0] || '').trim();
        const year = data.year || '';
        const item = {
          name: data.name.trim(),
          imageUrl: data.set_img_url || '',
          setNum,
          officialId,
          year
        };
        await setCacheItem(normalized, item);
        failState.delete(normalized);
        return item;

      } catch (e) {
        logDebug('Rebrickable fetch exception:', e);
        incrementFail(normalized);
        return null;
      }
    })();

    inflight.set(normalized, p);
    try { return await p; }
    finally { inflight.delete(normalized); }
  }

  function incrementFail(id) {
    const fs = failState.get(id) || { attempts: 0, lastAttemptAt: 0 };
    fs.attempts += 1;
    fs.lastAttemptAt = Date.now();
    failState.set(id, fs);
    logDebug(`ID ${id} failed attempt ${fs.attempts}/${MAX_ATTEMPTS_PER_ID_PER_PAGE}`);
  }

  // ====== ID PARSERS (M & N) ======
  function extractAnyIdFromText(text) {
    const m = (text || '').toUpperCase().match(/\b([MN]\d+)\b/);
    return m ? m[1] : null; // "Mxxxxx" or "Nxxxxx"
  }

  function extractAnyIdFromHref(href = '') {
    // Prefer explicit product path; capture m|n followed by digits anywhere in slug
    let x = href.match(/\/products\/.*?([mn]\d+)/i);
    if (x) return x[1].toUpperCase();

    // Fallback: any m|n\d+ anywhere
    let y = href.match(/([mn]\d+)/i);
    if (y) return y[1].toUpperCase();

    // Final fallback: numeric /products/12345 -> treat as M12345 (legacy)
    let n = href.match(/\/products\/(\d+)/i);
    if (n) return `M${n[1]}`.toUpperCase();

    return null;
  }

  // ====== IMAGE FIT HELPERS ======
  function applyContainCenterFit(img) {
    if (!img) return;
    const wrapper = img.parentElement || img.closest('.card__media, .product-card__image, .media, .product__media') || img;
    if (wrapper && getComputedStyle(wrapper).position === 'static') {
      wrapper.style.position = 'relative';
    }
    img.style.position = 'absolute';
    img.style.top = '50%';
    img.style.left = '50%';
    img.style.transform = 'translate(-50%, -50%)';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.objectFit = 'contain';
    img.style.objectPosition = 'center center';
    img.style.transition = 'none';
    img.style.willChange = 'auto';
  }

  function killZoomyClasses(node) {
    const zoomClasses = [
      'card--media-hover','media--hover','hover-zoom','image-hover','hover-effect',
      'zoom','zoom-image','zoom-on-hover','media--cropped','media--square','media--landscape','media--portrait'
    ];
    zoomClasses.forEach(c => node.classList?.remove(c));
  }

  // ====== ANTI-FLICKER CSS (scoped to product gallery only) ======
  function applyNoFlickerCSSForGallery(card) {
    if (!card) return;
    card.setAttribute('data-mt-no-flicker', '1');

    if (document.getElementById('mt-no-flicker-css')) return;
    const css = `
    [data-mt-no-flicker] * { transition: none !important; animation: none !important; }
    [data-mt-no-flicker] *:hover { transform: none !important; }
    [data-mt-no-flicker] picture source { display: none !important; }
    [data-mt-no-flicker] .media,
    [data-mt-no-flicker] .product__media,
    [data-mt-no-flicker] .product-gallery__media { background: none !important; }
    [data-mt-no-flicker] img { opacity: 1 !important; backface-visibility: hidden; will-change: auto; }
    [data-mt-no-flicker] .zoom,
    [data-mt-no-flicker] .zoom-image,
    [data-mt-no-flicker] .zoom-on-hover,
    [data-mt-no-flicker] .media--hover,
    [data-mt-no-flicker] .hover-zoom,
    [data-mt-no-flicker] .image-hover,
    [data-mt-no-flicker] .hover-effect { transform: none !important; }
    `;
    const style = document.createElement('style');
    style.id = 'mt-no-flicker-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ====== IMAGES ======
  function setCardImageSingle(card, url, altText) {
    killZoomyClasses(card);

    const wrappers = [
      card,
      card.querySelector('.card__media'),
      card.querySelector('.product-card__image'),
      card.querySelector('.media'),
      card.querySelector('.media--cropped'),
    ].filter(Boolean);
    wrappers.forEach(w => {
      w.style.overflow = 'hidden';
      w.style.transform = 'none';
    });

    const imgs = Array.from(card.querySelectorAll('img'));
    const sources = Array.from(card.querySelectorAll('picture source'));
    const bgEls = Array.from(card.querySelectorAll('[style*="background-image"], .media, .product-card__image, .card__media'));

    const first = imgs[0];
    if (first && url) {
      first.src = url;
      first.removeAttribute('sizes');
      first.removeAttribute('data-sizes');
      first.srcset = `${url} 360w, ${url} 540w, ${url} 720w, ${url} 1024w`;
      if (altText) first.alt = altText;
      applyContainCenterFit(first);
    }

    imgs.slice(1).forEach(img => {
      img.style.display = 'none';
      img.style.transform = 'none';
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
    });

    sources.forEach(src => {
      src.srcset = '';
      src.removeAttribute('sizes');
      src.style.display = 'none';
    });

    bgEls.forEach(el => {
      el.style.backgroundImage = 'none';
      el.style.transform = 'none';
    });
  }

  function setCartImageSafe(container, url, altText) {
    const img = container.querySelector('img');
    if (!img) return;

    if (url) {
      img.src = url;
      if (!img.srcset) {
        img.srcset = `${url} 360w, ${url} 540w, ${url} 720w, ${url} 1024w`;
      }
    }
    if (altText) img.alt = altText;

    img.style.objectFit = 'contain';
    img.style.objectPosition = 'center center';
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.maxHeight = '160px';
    img.style.transform = 'none';
    img.style.transition = 'none';
  }

  // ==== WISHLIST: safe updater (like cart), minimal interference ====
  function setWishlistImageSafe(container, url, altText) {
    const img = container.querySelector('img') || container.querySelector('picture img');
    if (!img) return;

    if (url) {
      img.src = url;
      if (!img.srcset) {
        img.srcset = `${url} 360w, ${url} 540w, ${url} 720w, ${url} 1024w`;
      }
    }
    if (altText) img.alt = altText;

    // Gentle sizing only, do not break layout
    img.style.objectFit = 'contain';
    img.style.objectPosition = 'center center';
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.maxHeight = '200px'; // wishlist thumbs can be a bit taller
    img.style.transform = 'none';
    img.style.transition = 'none';
  }

  function setGalleryImages(bundle, url, altText) {
    const { card, imgs, sources, bgEls } = bundle;

    applyNoFlickerCSSForGallery(card);
    killZoomyClasses(card);
    card.style.transform = 'none';
    card.style.transition = 'none';

    imgs.forEach((img, i) => {
      img.style.opacity = '1';
      img.style.zIndex = i === 0 ? '1' : '0';
    });

    sources.forEach(source => {
      source.srcset = '';
      source.removeAttribute('sizes');
      source.style.display = 'none';
    });

    bgEls.forEach(el => {
      el.style.backgroundImage = 'none';
      el.style.transform = 'none';
    });

    imgs.forEach(img => {
      if (url) {
        img.src = url;
        img.removeAttribute('sizes');
        img.removeAttribute('data-sizes');
        img.srcset = `${url} 360w, ${url} 540w, ${url} 720w, ${url} 1024w`;
        if (altText) img.alt = altText;
      }
      applyContainCenterFit(img);
      img.style.transform = 'translate(-50%, -50%)';
      img.style.transition = 'none';
    });

    card.onmouseenter = () => { card.style.transform = 'none'; };
    card.onmouseleave = () => { card.style.transform = 'none'; };
  }

  // ====== TITLE FORMAT ======
  function formatTitle(data, originalId) {
    const rawId = (originalId || '').toUpperCase();
    const officialId = (data.officialId || '').trim();
    const name = (data.name || '').trim();
    const yearPart = data.year ? ` (${data.year})` : '';
    const left = officialId && name ? `${officialId} - ${name}` : (officialId || name);
    const right = rawId ? ` - ${rawId}` : '';
    return `${left}${yearPart}${right}`.trim();
  }

  function applyTitleToAllTitleElementsInCard(card, finalText) {
    const selectors = [
      '.full-unstyled-link',
      '.card__heading a', '.card__heading',
      '.product-card__title', '.product-title', '.title', '.product-item__title',
      'h1','h2','h3','h4','a[href*="/products/"]'
    ];
    let changed = false;
    selectors.forEach(sel => {
      card.querySelectorAll(sel).forEach(el => {
        const txt = (el.textContent || '').trim().toUpperCase();
        if (/M\d+|N\d+|PARTS KIT|MOC/.test(txt) || sel.includes('unstyled-link') || sel.includes('card__heading')) {
          el.textContent = finalText;
          changed = true;
        }
      });
    });
    if (!changed) {
      const a = card.querySelector('a[href*="/products/"]');
      if (a) a.textContent = finalText;
    }
  }

  function applyTitleToCartLine(line, finalText) {
    const selectors = [
      '.cart__product-name', '.cart__product-title',
      '.cart-item__name', '.cart-item__details a',
      '.cart__product-title a', 'a[href*="/products/"]'
    ];
    let changed = false;
    selectors.forEach(sel => {
      line.querySelectorAll(sel).forEach(el => {
        const txt = (el.textContent || '').trim().toUpperCase();
        if (/M\d+|N\d+|PARTS KIT|MOC/.test(txt) || sel.includes('cart-item__name') || sel.includes('product-title')) {
          el.textContent = finalText;
          changed = true;
        }
      });
    });
    if (!changed) {
      const a = line.querySelector('a[href*="/products/"]');
      if (a) a.textContent = finalText;
    }
  }

  // ====== DISCOVERY ======
  function discoverListingCards(root = document) {
    const links = Array.from(root.querySelectorAll('a[href*="/products/"]'));
    const seen = new Set();
    const cards = [];
    links.forEach(a => {
      const id = extractAnyIdFromHref(a.getAttribute('href') || a.href || '') ||
                 extractAnyIdFromText(a.textContent || '') ||
                 extractAnyIdFromText(a.parentElement?.textContent || '');
      if (!id) return;
      const card = a.closest(
        'article, li, .card, .grid__item, .product-card, .product, .product-card-wrapper, .collection-product, .product-item, .product-tile, .product-grid-item, .home-product-card, .featured-product'
      );
      if (!card || seen.has(card)) return;
      seen.add(card);
      cards.push({ id, card });
    });
    return cards;
  }

  function discoverCartLines() {
    const container = document.querySelector('form[action="/cart"], #Cart, .cart, .cart__items, .cart-items, .cart__content') || document;
    const lines = Array.from(container.querySelectorAll('.cart__row, .cart__item, .cart-item, .cart-items .cart-item, tr.cart__row'));
    const out = [];
    lines.forEach(line => {
      const a = line.querySelector('a[href*="/products/"]');
      if (!a) return;
      const id = extractAnyIdFromHref(a.getAttribute('href') || a.href || '') ||
                 extractAnyIdFromText(line.textContent || '');
      if (!id) return;
      out.push({ id, line });
    });
    return out;
  }

  // ==== WISHLIST DISCOVERY (friendly & isolated like cart) ====
  function discoverWishlistItems() {
    const isWish = isWishlistPage();
    if (!isWish) return [];

    const root =
      document.querySelector('#wishlist, .wishlist, [data-wishlist], .page-width, main') || document;

    const items = [];

    // Case A: explicit wishlist text nodes like earlier builds (p.p-text-wish_desc)
    const wishDescs = Array.from(root.querySelectorAll('p.p-text-wish_desc, .wishlist-item__desc, .wish__desc, .p-text-wish_desc'));
    wishDescs.forEach(el => {
      const idFromText = extractAnyIdFromText(el.textContent || '');
      if (!idFromText) return;
      const line = el.closest('.wishlist-item, li, .grid__item, .card, .product, .product-card') || el.parentElement || el;
      items.push({ id: idFromText, line });
    });

    // Case B: fall back—links to products inside wishlist list/grid
    const links = Array.from(root.querySelectorAll('a[href*="/products/"]'));
    links.forEach(a => {
      const id = extractAnyIdFromHref(a.getAttribute('href') || a.href || '') ||
                 extractAnyIdFromText(a.textContent || '');
      if (!id) return;
      const line = a.closest('.wishlist-item, li, .grid__item, .card, .product, .product-card, article') || a;
      // Avoid duplicates by line+id combo
      if (!items.some(x => x.line === line)) {
        items.push({ id, line });
      }
    });

    return items;
  }

  // ====== PROCESSORS (PARALLEL) ======
  async function processListingPage(root = document) {
    const cards = discoverListingCards(root);
    await Promise.all(cards.map(async ({ id, card }) => {
      const data = (await getCacheItem(id)) || await fetchRebrickableData(id);
      if (data && !INVALID_KEYWORDS.some(k => data.name.includes(k))) {
        const finalText = formatTitle(data, id);
        applyTitleToAllTitleElementsInCard(card, finalText);
        if (data.imageUrl) setCardImageSingle(card, data.imageUrl, data.name);
      }
    }));
  }

  async function processCartPage() {
    const lines = discoverCartLines();
    await Promise.all(lines.map(async ({ id, line }) => {
      const data = (await getCacheItem(id)) || await fetchRebrickableData(id);
      if (data && !INVALID_KEYWORDS.some(k => data.name.includes(k))) {
        const finalText = formatTitle(data, id);
        applyTitleToCartLine(line, finalText);

        const imgWrap =
          line.querySelector('.cart-item__image, .cart__image, .cart__media, .media, .cart-item__media, .cart__image-wrapper') ||
          line;
        setCartImageSafe(imgWrap, data.imageUrl || '', data.name);
      }
    }));
  }

  // ==== WISHLIST PROCESSOR ====
  async function processWishlistPage() {
    const items = discoverWishlistItems();
    await Promise.all(items.map(async ({ id, line }) => {
      const data = (await getCacheItem(id)) || await fetchRebrickableData(id);
      if (!data || INVALID_KEYWORDS.some(k => data.name.includes(k))) return;

      // Title update — be conservative like cart
      const finalText = formatTitle(data, id);
      const titleNodes = [
        '.wishlist-item__title', '.product-title', '.product-card__title',
        '.full-unstyled-link', 'a[href*="/products/"]', 'p.p-text-wish_desc', '.wish__desc'
      ];
      let updated = false;
      titleNodes.forEach(sel => {
        line.querySelectorAll(sel).forEach(el => {
          const up = (el.textContent || '').toUpperCase();
          if (/M\d+|N\d+|PARTS KIT|MOC/.test(up) || sel.includes('wish') || sel.includes('product-title')) {
            el.textContent = finalText;
            updated = true;
          }
        });
      });
      if (!updated) {
        const a = line.querySelector('a[href*="/products/"]');
        if (a) a.textContent = finalText;
      }

      // Image update — safe (do not break layout)
      const imgWrap =
        line.querySelector('.wishlist-item__image, .product-card__image, .card__media, .media, picture') ||
        line;
      setWishlistImageSafe(imgWrap, data.imageUrl || '', data.name);
    }));
  }

  // ====== PRODUCT PAGE HELPERS ======
  function getProductGalleryBundle() {
    const main = document.querySelector('main') || document.body;
    const scope =
      main.querySelector('[data-product-single-media-wrapper], [data-product-media-gallery], .product__media, .product-media, .product-gallery, .product__gallery, .product__media-list, .media-gallery, .product-gallery__media, .product__slides') ||
      main;
    const imgs = Array.from(scope.querySelectorAll('img'));
    const sources = Array.from(scope.querySelectorAll('picture source'));
    const bgEls = Array.from(scope.querySelectorAll('[style*="background-image"], .media, .product__media, .product-gallery__media'));
    return { card: scope, imgs, sources, bgEls };
  }

  function getPrimaryProductScope() {
    const main = document.querySelector('main') || document.body;
    return main;
  }

  async function processProductPage() {
    const scope = getPrimaryProductScope();

    let productId = lockedProductId;
    if (!productId) {
      const fromUrl = extractAnyIdFromHref(location.pathname);
      if (fromUrl) {
        productId = fromUrl;
        lockedProductId = fromUrl;
      } else {
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = walker.nextNode())) {
          const id = extractAnyIdFromText(n.nodeValue);
          if (id) { productId = id; lockedProductId = id; break; }
        }
      }
    }
    if (!productId) return;

    const data = (await getCacheItem(productId)) || await fetchRebrickableData(productId);
    if (data && !INVALID_KEYWORDS.some(k => data.name.includes(k))) {
      const formatted = formatTitle(data, productId);
      const h1 = scope.querySelector('h1.product__title, h1.product-title, h1');
      if (h1) h1.textContent = formatted;
      const galleryBundle = getProductGalleryBundle();
      if (data.imageUrl) setGalleryImages(galleryBundle, data.imageUrl, data.name);
    }

    const recRoots = Array.from(document.querySelectorAll(
      '.related, .recommendations, [data-section-type*="recommendations"], .product-recommendations, .recently-viewed, [data-section-type*="recent"]'
    ));
    for (const r of recRoots) {
      await processListingPage(r);
    }
  }

  // ====== ROUTER ======
  function isProductPage() {
    return !!document.querySelector('meta[property="og:type"][content="product"]') ||
           location.pathname.includes('/products/');
  }
  function isCartPage() {
    return location.pathname === '/cart';
  }
  function isWishlistPage() {
    // Accept /pages/wishlist_5e.buvk with or without ?groupId=...
    return location.pathname.startsWith('/pages/wishlist_5e.buvk');
  }

  async function determineAndProcessPage() {
    if (!readyRanOnce) {
      readyRanOnce = true;
    }

    // Process generic listing-like areas on EVERY page
    await processListingPage(document);

    // Dedicated modes (isolated to avoid breaking other pages)
    if (isCartPage()) {
      await processCartPage();
    }
    if (isWishlistPage()) {
      await processWishlistPage();
    }
    if (isProductPage()) {
      await processProductPage();
    }
  }

  // ====== MESSAGE LISTENER ======
  chrome.runtime?.onMessage?.addListener((request, sender, sendResponse) => {
    if (request?.action === 'convert') {
      determineAndProcessPage();
      sendResponse?.({ status: 'Update complete!' });
    }
  });

  // ====== SPA / LAZY LOADING HANDLER ======
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length > 0) {
        clearTimeout(observer._t);
        observer._t = setTimeout(determineAndProcessPage, 150);
        break;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', determineAndProcessPage, { once: true });
  } else {
    determineAndProcessPage();
  }
})();
