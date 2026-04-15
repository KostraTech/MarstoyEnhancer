(function (global) {
  const STORAGE_KEYS = Object.freeze({
    catalogData: 'CATALOG_DATA',
    catalogLastUpdated: 'CATALOG_LAST_UPDATED',
    allBrickKits: 'ALL_BRICK_KITS',
    allBrickKitsLastSync: 'ALL_BRICK_KITS_LAST_SYNC',
    showMeSearch: 'SHOW_ME_SEARCH',
    initialSyncDone: 'INITIAL_SYNC_DONE',
    meSearchPosition: 'ME_SEARCH_POSITION',
    updateCheckCache: 'GITHUB_RELEASE_CHECK_CACHE',
  });

  const MESSAGE_TYPES = Object.freeze({
    catalogStatus: 'CATALOG_STATUS',
    refreshCatalog: 'REFRESH_CATALOG',
    syncCollection: 'SYNC_COLLECTION',
    lookupSet: 'LOOKUP_SET',
    toggleMeSearchVisibility: 'TOGGLE_ME_SEARCH_VISIBILITY',
  });

  const DOM_SELECTORS = Object.freeze({
    listingLink: 'a[href*="/products/"]',
    listingCard: [
      'article', 'li', '.card', '.grid__item', '.product-card', '.product',
      '.product-card-wrapper', '.collection-product', '.product-item', '.product-tile',
      '.product-grid-item', '.home-product-card', '.featured-product', '.recommend-product-item',
      '.swiper-slide', '.product-item-swiper-list', '.recommend-product-item-image-wrapper'
    ].join(', '),
    cartContainer: [
      'theme-cart-drawer', '.cart-drawer', '.cart-drawer__body', '.cart-drawer__items',
      '.cart-drawer__inner', 'form[action="/cart"]', '#Cart', '.cart', '.cart__items',
      '.cart-items', '.cart__content'
    ].join(', '),
    cartLine: '.cart__row, .cart__item, .cart-item, .cart-items .cart-item, tr.cart__row',
    recommendationRoot: [
      '.related', '.recommendations', '[data-section-type*="recommendations"]',
      '.product-recommendations', '.recently-viewed', '[data-section-type*="recent"]',
      '.you-may-also-like', '.product__recommendations', '[id*="recommend" i]', '[class*="recommend" i]'
    ].join(', '),
    productTitle: 'h1.product__title, h1.product-title, h1',
    productMutationTarget: 'main, h1, .product__title, .product-title',
    productMediaScope: [
      '[data-product-single-media-wrapper]', '[data-product-media-gallery]', '.product__media',
      '.product-media', '.product-gallery', '.product__gallery', '.product__media-list',
      '.media-gallery', '.product-gallery__media', '.product__slides'
    ].join(', '),
    cardMedia: '.block-product-image, .recommend-product-item-image, .recommend-product-item-image-media, .card__media, .product-card__image, .media, .media--cropped',
    cardBgReset: '[style*="background-image"], .recommend-product-item-image-media, .recommend-product-item-image, .media, .product-card__image, .card__media',
    cartImageWrap: '.cart-item_picture, .cart-item__picture, .cart-item__image, .cart__image, .cart__media, .media, .cart-item__media, .cart__image-wrapper, .cart-item_product',
    listingOrRecommendationMutation: [
      'a[href*="/products/"]',
      'article', 'li', '.card', '.grid__item', '.product-card', '.product',
      '.product-card-wrapper', '.collection-product', '.product-item', '.product-tile',
      '.product-grid-item', '.home-product-card', '.featured-product', '.recommend-product-item',
      '.swiper-slide', '.product-item-swiper-list', '.recommend-product-item-image-wrapper',
      '.related', '.recommendations', '[data-section-type*="recommendations"]',
      '.product-recommendations', '.recently-viewed', '[data-section-type*="recent"]',
      '.you-may-also-like', '.product__recommendations', '[id*="recommend" i]', '[class*="recommend" i]',
      'theme-cart-drawer', '.cart-drawer', '.cart-drawer__body', '.cart-drawer__items',
      '.cart-drawer__inner', 'form[action="/cart"]', '#Cart', '.cart', '.cart__items',
      '.cart-items', '.cart__content', '.cart__row', '.cart__item', '.cart-item',
      'h1.product__title', 'h1.product-title', 'h1'
    ].join(', '),
  });

  const INTERNAL_NODE_IDS = Object.freeze([
    'mt-marstoy-wrapper',
    'mt-me-search-css',
    'mt-no-flicker-css',
  ]);

  function normalizeStoreId(value) {
    return String(value || '').trim().toUpperCase();
  }

  function cacheKey(value) {
    return normalizeStoreId(value);
  }

  function toOfficialId(storeId) {
    const normalized = normalizeStoreId(storeId);
    if (!normalized) return '';

    if (normalized === 'N179957') {
      return '75997';
    }

    return normalized.slice(1).split('').reverse().join('');
  }

  function normalizeVersionTag(tag) {
    return String(tag || '').trim().replace(/^v/i, '');
  }

  function compareVersions(a, b) {
    const aParts = normalizeVersionTag(a).split('.').map(x => parseInt(x, 10) || 0);
    const bParts = normalizeVersionTag(b).split('.').map(x => parseInt(x, 10) || 0);
    const len = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < len; i++) {
      const av = aParts[i] || 0;
      const bv = bParts[i] || 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }

    return 0;
  }

  function formatTimestamp(ts) {
    if (!ts) return 'never';

    try {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return String(ts);
    }
  }

  global.MarstoyShared = {
    STORAGE_KEYS,
    MESSAGE_TYPES,
    normalizeStoreId,
    cacheKey,
    toOfficialId,
    normalizeVersionTag,
    compareVersions,
    formatTimestamp,
    DOM_SELECTORS,
    INTERNAL_NODE_IDS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
