(function (global) {
  const {
    extractAnyIdFromHref,
    extractAnyIdFromText,
    getAllowedProductIdFromCurrentPath,
    lookupFromCatalog,
  } = global.MarstoyRuntime;
  const {
    DOM_SELECTORS,
    INTERNAL_NODE_IDS,
  } = global.MarstoyShared;
  const { setCardImage, setCartImage, startStubbornProductImageLock } = global.MarstoyImages;

  const catalogLookupMemo = new Map();
  let stubbornRelatedStarted = false;

  const TITLE_DECORATED_ATTR = 'data-mt-title-key';
  const IMAGE_DECORATED_ATTR = 'data-mt-image-key';
  const LISTING_TITLE_BALANCED_ATTR = 'data-mt-listing-title-balanced';

  function formatTitle(data, originalId) {
    const rawId = (originalId || '').toUpperCase();
    const officialId = (data.officialId || '').trim();
    const name = (data.name || '').trim();
    const yearPart = data.year ? ` (${data.year})` : '';

    const left = officialId && name ? `${officialId} - ${name}` : (officialId || name);
    const right = rawId ? ` - ${rawId}` : '';

    return `${left}${yearPart}${right}`.trim();
  }

  function isProbablyPriceText(text) {
    const t = (text || '').trim();
    if (!t) return false;
    return /[$€£¥]|\bczk\b|\busd\b|\beur\b|\bgbp\b|\bpln\b|\bkc\b|\d+[.,]\d{2}/i.test(t);
  }

  function isPriceLikeElement(el) {
    if (!el) return false;
    const cls = ((el.className && String(el.className)) || '').toLowerCase();
    if (cls.includes('price') || cls.includes('money')) return true;
    return isProbablyPriceText(el.textContent || '');
  }

  function replaceBestTextInScope(scope, finalText) {
    if (!scope) return null;

    const candidates = Array.from(scope.querySelectorAll(
      '[class*="title" i], [class*="name" i], h1, h2, h3, h4, h5, a, span, div, p'
    ));

    for (const el of candidates) {
      if (!el || !el.textContent || isPriceLikeElement(el)) continue;
      if (!(el.textContent || '').trim()) continue;
      el.textContent = finalText;
      return el;
    }

    return null;
  }

  function shouldReplaceTitleText(text, selector, selectorHints) {
    return (
      PRODUCT_CODE_PATTERN.test(text) ||
      selectorHints.some(hint => selector.includes(hint))
    );
  }

  function applyTitleTextBySelectors(scope, selectors, finalText, selectorHints, { skipPriceLike = false } = {}) {
    for (const selector of selectors) {
      const matches = scope.querySelectorAll(selector);
      for (const el of matches) {
        if (skipPriceLike && isPriceLikeElement(el)) continue;

        const text = (el.textContent || '').trim().toUpperCase();
        if (!shouldReplaceTitleText(text, selector, selectorHints)) continue;

        el.textContent = finalText;
        return el;
      }
    }

    return null;
  }

  function replaceBestTextInFirstMatchingScope(root, scopeSelector, finalText) {
    return replaceBestTextInScope(root.querySelector(scopeSelector), finalText);
  }


  function ensureListingTitleBalanceCss() {
    if (document.getElementById('mt-listing-title-balance-css')) return;

    const style = document.createElement('style');
    style.id = 'mt-listing-title-balance-css';
    style.textContent = `
    [${LISTING_TITLE_BALANCED_ATTR}="1"] {
      display: -webkit-box !important;
      -webkit-box-orient: vertical !important;
      -webkit-line-clamp: 2 !important;
      overflow: hidden !important;
      white-space: normal !important;
      line-height: 1.35 !important;
      min-height: calc(1.35em * 2) !important;
      max-height: calc(1.35em * 2) !important;
      overflow-wrap: anywhere !important;
    }
    `;
    document.head.appendChild(style);
  }

  function balanceListingTitleElement(el) {
    if (!el) return el;
    ensureListingTitleBalanceCss();
    el.setAttribute(LISTING_TITLE_BALANCED_ATTR, '1');
    return el;
  }

  const LISTING_LINK_SELECTOR = DOM_SELECTORS.listingLink;
  const LISTING_CARD_SELECTOR = DOM_SELECTORS.listingCard;
  const CART_CONTAINER_SELECTOR = DOM_SELECTORS.cartContainer;
  const CART_LINE_SELECTOR = DOM_SELECTORS.cartLine;
  const RECOMMENDATION_ROOT_SELECTOR = DOM_SELECTORS.recommendationRoot;
  const PRODUCT_TITLE_SELECTOR = DOM_SELECTORS.productTitle;
  const PRODUCT_MUTATION_TARGET_SELECTOR = DOM_SELECTORS.productMutationTarget;
  const CART_IMAGE_WRAP_SELECTOR = DOM_SELECTORS.cartImageWrap;
  const LISTING_TITLE_SELECTORS = [
    '.full-unstyled-link', '.card__heading a', '.card__heading', '.product-card__title',
    '.product-title', '.title', '.product-item__title', '.block-product-item__title',
    '.block-product-info__title', '.recommend-product-item-title',
    '.recommend-product-item-info [class*="title" i]',
    '.recommend-product-item-info [class*="name" i]', '.recommend-product-item-info a',
    'h1', 'h2', 'h3', 'h4', 'a[href*="/products/"]'
  ];
  const CART_TITLE_SELECTORS = [
    '.cart__product-name', '.cart__product-title', '.cart__product-title a', '.cart-item__name',
    '.cart-item__name a', '.cart-item__details a', '.cart-item__title', '.cart-item__product-title',
    '.cart-item_product-infos a', '.cart-item_product a'
  ];
  const LISTING_FALLBACK_SCOPE_SELECTOR = '.recommend-product-item-info, .block-product-info, .product-item__info, .card__content, .product-card__info';
  const CART_FALLBACK_LINK_SELECTOR = '.cart-item_product-infos a[href*="/products/"], .cart-item__details a[href*="/products/"], .cart-item__name a[href*="/products/"], .cart__product-title a[href*="/products/"]';
  const PRODUCT_CODE_PATTERN = /M\d+|N\d+|PARTS KIT|MOC/;

  function applyTitleToListingCard(card, finalText) {
    let titleEl = applyTitleTextBySelectors(
      card,
      LISTING_TITLE_SELECTORS,
      finalText,
      ['unstyled-link', 'card__heading', 'recommend-product-item', 'block-product'],
      { skipPriceLike: true }
    );

    if (!titleEl) {
      titleEl = replaceBestTextInFirstMatchingScope(card, LISTING_FALLBACK_SCOPE_SELECTOR, finalText);
    }

    if (!titleEl) {
      const link = card.matches(LISTING_LINK_SELECTOR) ? card : card.querySelector(LISTING_LINK_SELECTOR);
      if (link && !link.querySelector('img')) {
        link.textContent = finalText;
        titleEl = link;
      }
    }

    if (titleEl) {
      balanceListingTitleElement(titleEl);
      return;
    }

    const dataNameEl = card.querySelector('[data-name]');
    if (dataNameEl) dataNameEl.setAttribute('data-name', finalText);
  }

  function applyTitleToCartLine(line, finalText) {
    const changed = applyTitleTextBySelectors(
      line,
      CART_TITLE_SELECTORS,
      finalText,
      ['cart-item', 'cart__product']
    );

    if (!changed) {
      const link = line.querySelector(CART_FALLBACK_LINK_SELECTOR);
      if (link) link.textContent = finalText;
    }
  }
  function findListingCards(root = document) {
    const links = [];
    if (root.matches?.(LISTING_LINK_SELECTOR)) {
      links.push(root);
    }
    if (root.querySelectorAll) {
      links.push(...root.querySelectorAll(LISTING_LINK_SELECTOR));
    }
    const seen = new Set();
    const cards = [];

    links.forEach(link => {
      const id =
        extractAnyIdFromHref(link.getAttribute('href') || link.href || '') ||
        extractAnyIdFromText(link.textContent || '') ||
        extractAnyIdFromText(link.parentElement?.textContent || '');

      if (!id) return;

      const card = link.closest(LISTING_CARD_SELECTOR);
      if (!card || seen.has(card)) return;
      seen.add(card);
      cards.push({ id, card });
    });

    return cards;
  }

  function findCartLines(root = document) {
    const containers = Array.from(root.querySelectorAll ? root.querySelectorAll(CART_CONTAINER_SELECTOR) : []);
    const scopes = containers.length ? containers : [root];
    const seen = new Set();
    const out = [];

    scopes.forEach(container => {
      const lines = Array.from(container.querySelectorAll(CART_LINE_SELECTOR));

      lines.forEach(line => {
        if (seen.has(line)) return;
        seen.add(line);

        const link = line.querySelector(LISTING_LINK_SELECTOR);
        if (!link) return;

        const id =
          extractAnyIdFromHref(link.getAttribute('href') || link.href || '') ||
          extractAnyIdFromText(line.textContent || '');
        if (!id) return;

        out.push({ id, line });
      });
    });

    return out;
  }

  function getRecommendationRoots(root = document) {
    if (!root) return [];
    if (root.matches?.(RECOMMENDATION_ROOT_SELECTOR)) return [root];
    return Array.from(root.querySelectorAll(RECOMMENDATION_ROOT_SELECTOR));
  }

  async function getCatalogDataMemoized(id) {
    const cacheKey = String(id || '').toUpperCase();
    if (!cacheKey) return null;

    if (!catalogLookupMemo.has(cacheKey)) {
      catalogLookupMemo.set(cacheKey, lookupFromCatalog(cacheKey).catch(() => null));
    }

    return catalogLookupMemo.get(cacheKey);
  }

  function markDecorated(el, key) {
    if (!el || !key) return;
    el.setAttribute('data-mt-decorated-key', key);
  }

  function isAlreadyDecorated(el, key) {
    if (!el || !key) return false;
    return el.getAttribute('data-mt-decorated-key') === key;
  }

  function markTitleDecorated(el, key) {
    if (!el || !key) return;
    el.setAttribute(TITLE_DECORATED_ATTR, key);
  }

  function isTitleAlreadyDecorated(el, key) {
    if (!el || !key) return false;
    return el.getAttribute(TITLE_DECORATED_ATTR) === key;
  }

  function markImageDecorated(el, key) {
    if (!el || !key) return;
    el.setAttribute(IMAGE_DECORATED_ATTR, key);
  }

  function isImageAlreadyDecorated(el, key) {
    if (!el || !key) return false;
    return el.getAttribute(IMAGE_DECORATED_ATTR) === key;
  }

  function getImageDecorateKey(data, id, scope) {
    const officialId = (data?.officialId || id || '').trim().toUpperCase();
    const imageUrl = (data?.imageUrl || '').trim();
    return `${scope}:${officialId}:${imageUrl}`;
  }

  let stubbornRelatedTimer = null;
  let stubbornRelatedObserver = null;
  let stubbornRelatedDebounce = null;
  let stubbornRelatedIdleTimer = null;

  const STUBBORN_RELATED_DEBOUNCE_MS = 120;
  const STUBBORN_RELATED_RETRY_DELAY_MS = 1200;
  const STUBBORN_RELATED_IDLE_STOP_MS = 5000;

  function stopStubbornRelatedLock() {
    stubbornRelatedStarted = false;
    if (stubbornRelatedTimer) {
      clearTimeout(stubbornRelatedTimer);
      stubbornRelatedTimer = null;
    }
    if (stubbornRelatedDebounce) {
      clearTimeout(stubbornRelatedDebounce);
      stubbornRelatedDebounce = null;
    }
    if (stubbornRelatedObserver) {
      stubbornRelatedObserver.disconnect();
      stubbornRelatedObserver = null;
    }
    if (stubbornRelatedIdleTimer) {
      clearTimeout(stubbornRelatedIdleTimer);
      stubbornRelatedIdleTimer = null;
    }
  }

  function startStubbornRelatedLock() {
    if (stubbornRelatedStarted) return;
    stopStubbornRelatedLock();
    stubbornRelatedStarted = true;

    let running = false;
    const applyNow = async () => {
      if (running) return;
      running = true;
      try {
        const roots = getRecommendationRoots();
        for (const root of roots) {
          await decorateListingPage(root);
        }
      } finally {
        running = false;
      }
    };

    const armIdleStop = () => {
      if (stubbornRelatedIdleTimer) {
        clearTimeout(stubbornRelatedIdleTimer);
      }
      stubbornRelatedIdleTimer = setTimeout(() => {
        stopStubbornRelatedLock();
      }, STUBBORN_RELATED_IDLE_STOP_MS);
    };

    const scheduleApply = (delay = STUBBORN_RELATED_DEBOUNCE_MS) => {
      armIdleStop();
      if (stubbornRelatedDebounce) {
        clearTimeout(stubbornRelatedDebounce);
      }
      stubbornRelatedDebounce = setTimeout(() => {
        stubbornRelatedDebounce = null;
        applyNow();
      }, delay);
    };

    applyNow();
    armIdleStop();
    stubbornRelatedTimer = setTimeout(() => {
      scheduleApply(0);
    }, STUBBORN_RELATED_RETRY_DELAY_MS);

    const main = document.querySelector('main') || document.body;
    stubbornRelatedObserver = new MutationObserver(mutList => {
      for (const mutation of mutList) {
        if (mutation.type !== 'childList' || !mutation.addedNodes || mutation.addedNodes.length === 0) continue;
        for (const node of mutation.addedNodes) {
          if (mutationCanAffectListing(node)) {
            scheduleApply();
            return;
          }
        }
      }
    });
    stubbornRelatedObserver.observe(main, {
      childList: true,
      subtree: true,
    });
  }

  function isProductPage() {
    return (
      !!document.querySelector('meta[property="og:type"][content="product"]') ||
      location.pathname.includes('/products/')
    );
  }

  function hasCartUi() {
    return !!document.querySelector(
      'theme-cart-drawer, .cart-drawer, .cart-drawer__body, .cart-drawer__items, .cart-item, .cart__item, form[action="/cart"]'
    );
  }

  async function decorateListingPage(root = document) {
    const cards = findListingCards(root);
    if (!cards.length) return;

    const uniqueIds = Array.from(new Set(cards.map(({ id }) => String(id || '').toUpperCase()).filter(Boolean)));
    await Promise.all(uniqueIds.map(id => getCatalogDataMemoized(id)));

    await Promise.all(cards.map(async ({ id, card }) => {
      const data = await getCatalogDataMemoized(id);
      if (!data) return;

      const finalText = formatTitle(data, id);
      const titleKey = `listing:${id}:${finalText}`;
      const imageKey = getImageDecorateKey(data, id, 'listing');
      const decorateKey = `${titleKey}|${imageKey}`;
      if (isAlreadyDecorated(card, decorateKey)) return;

      if (!isTitleAlreadyDecorated(card, titleKey)) {
        applyTitleToListingCard(card, finalText);
        markTitleDecorated(card, titleKey);
      }

      if (!isImageAlreadyDecorated(card, imageKey)) {
        setCardImage(card, data);
        markImageDecorated(card, imageKey);
      }

      markDecorated(card, decorateKey);
    }));
  }

  async function decorateCartPage(root = document) {
    const lines = findCartLines(root);
    if (!lines.length) return;

    const uniqueIds = Array.from(new Set(lines.map(({ id }) => String(id || '').toUpperCase()).filter(Boolean)));
    await Promise.all(uniqueIds.map(id => getCatalogDataMemoized(id)));

    await Promise.all(lines.map(async ({ id, line }) => {
      const data = await getCatalogDataMemoized(id);
      if (!data) return;

      const finalText = formatTitle(data, id);
      const titleKey = `cart:${id}:${finalText}`;
      const imageKey = getImageDecorateKey(data, id, 'cart');
      const decorateKey = `${titleKey}|${imageKey}`;
      if (isAlreadyDecorated(line, decorateKey)) return;

      if (!isTitleAlreadyDecorated(line, titleKey)) {
        applyTitleToCartLine(line, finalText);
        markTitleDecorated(line, titleKey);
      }

      if (!isImageAlreadyDecorated(line, imageKey)) {
        const imgWrap = line.querySelector(
          CART_IMAGE_WRAP_SELECTOR
        ) || line;
        setCartImage(imgWrap, data);
        markImageDecorated(line, imageKey);
      }

      markDecorated(line, decorateKey);
    }));
  }

  async function decorateProductPage() {
    const scope = document.querySelector('main') || document.body;
    const allowedProductIdFromPath = getAllowedProductIdFromCurrentPath();

    const data = allowedProductIdFromPath
      ? await getCatalogDataMemoized(allowedProductIdFromPath)
      : null;

    if (data && allowedProductIdFromPath) {
      const finalText = formatTitle(data, allowedProductIdFromPath);
      const productKey = `product:${allowedProductIdFromPath}:${finalText}`;
      const h1 = scope.querySelector(PRODUCT_TITLE_SELECTOR);
      if (h1 && !isTitleAlreadyDecorated(h1, productKey)) {
        h1.textContent = finalText;
        markTitleDecorated(h1, productKey);
        markDecorated(h1, productKey);
      }
      startStubbornProductImageLock(data);
    }

    const recRoots = getRecommendationRoots(scope);
    for (const root of recRoots) {
      await decorateListingPage(root);
    }

    startStubbornRelatedLock();
  }

  function mutationCanAffectListing(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches?.(LISTING_CARD_SELECTOR) || node.matches?.(LISTING_LINK_SELECTOR) || node.matches?.(RECOMMENDATION_ROOT_SELECTOR)) {
      return true;
    }
    return !!node.querySelector?.(`${LISTING_LINK_SELECTOR}, ${RECOMMENDATION_ROOT_SELECTOR}`);
  }

  function mutationCanAffectCart(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches?.(CART_CONTAINER_SELECTOR) || node.matches?.(CART_LINE_SELECTOR)) {
      return true;
    }
    return !!node.querySelector?.(`${CART_CONTAINER_SELECTOR}, ${CART_LINE_SELECTOR}`);
  }

  function mutationCanAffectProduct(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches?.(PRODUCT_MUTATION_TARGET_SELECTOR)) return true;
    return !!node.querySelector?.(PRODUCT_TITLE_SELECTOR);
  }

  async function decorateMutations(mutList) {
    const listingRoots = new Set();
    let shouldDecorateCart = false;
    let shouldDecorateProduct = false;

    for (const mutation of mutList || []) {
      if (mutation.type !== 'childList' || !mutation.addedNodes || mutation.addedNodes.length === 0) continue;

      for (const node of mutation.addedNodes) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        if (INTERNAL_NODE_IDS.includes(node.id)) continue;

        if (mutationCanAffectListing(node)) {
          listingRoots.add(node);
        }
        if (!shouldDecorateCart && mutationCanAffectCart(node)) {
          shouldDecorateCart = true;
        }
        if (!shouldDecorateProduct && mutationCanAffectProduct(node)) {
          shouldDecorateProduct = true;
        }
      }
    }

    if (listingRoots.size > 0) {
      await Promise.all(Array.from(listingRoots).map(root => decorateListingPage(root)));
    }

    if (shouldDecorateCart && hasCartUi()) {
      await decorateCartPage();
    }

    if (shouldDecorateProduct && isProductPage()) {
      await decorateProductPage();
    }
  }

  async function decoratePage() {
    await decorateListingPage(document);

    if (hasCartUi()) {
      await decorateCartPage(document);
    }

    if (isProductPage()) {
      await decorateProductPage();
    }
  }

  global.MarstoyTitles = {
    decoratePage,
    decorateMutations,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
