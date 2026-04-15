(function (global) {
  const { DOM_SELECTORS } = global.MarstoyShared;

  function getAbsoluteImageUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, location.href).toString();
    } catch {
      return url;
    }
  }

  const CARD_MEDIA_SELECTORS = DOM_SELECTORS.cardMedia;
  const CARD_BG_RESET_SELECTOR = DOM_SELECTORS.cardBgReset;
  const IMAGE_SCOPE_SELECTOR = `${DOM_SELECTORS.listingCard}, ${DOM_SELECTORS.cartLine}, ${DOM_SELECTORS.productMediaScope}`;
  const PRODUCT_MEDIA_SCOPE_SELECTOR = DOM_SELECTORS.productMediaScope;
  const CARD_IMAGE_APPLIED_ATTR = 'data-mt-image-applied';
  const CART_IMAGE_APPLIED_ATTR = 'data-mt-cart-image-applied';
  const PRODUCT_IMAGE_APPLIED_ATTR = 'data-mt-product-image-applied';
  const imageUrlVerdicts = new Map();
  const imageApplyVerdicts = new Map();
  const IMAGE_RECOVERY_DELAY_MS = 2800;
  const IMAGE_RECOVERY_MAX_ATTEMPTS = 2;

  function getImageUrlVerdict(url) {
    return url ? imageUrlVerdicts.get(getAbsoluteImageUrl(url)) || '' : '';
  }

  function setImageUrlVerdict(url, verdict) {
    if (!url || !verdict) return;
    imageUrlVerdicts.set(getAbsoluteImageUrl(url), verdict);
  }

  function getApplyVerdictKey(data) {
    const officialId = (data?.officialId || '').trim();
    const imageUrl = getAbsoluteImageUrl((data?.imageUrl || '').trim());
    return `${officialId}|${imageUrl}`;
  }

  function setApplyVerdict(data, verdict) {
    const key = getApplyVerdictKey(data);
    if (!key || !verdict) return;
    imageApplyVerdicts.set(key, verdict);
  }

  function getApplyVerdict(data) {
    const key = getApplyVerdictKey(data);
    return key ? imageApplyVerdicts.get(key) || '' : '';
  }

  function isImageLoadedForUrl(img, url) {
    if (!img || !url || !img.complete || img.naturalWidth <= 0) return false;
    const currentAbs = getAbsoluteImageUrl(img.currentSrc || img.src || '');
    return currentAbs === getAbsoluteImageUrl(url);
  }

  function clearImageRecoveryTimer(img) {
    if (!img || !img.__mtRecoveryTimer) return;
    clearTimeout(img.__mtRecoveryTimer);
    img.__mtRecoveryTimer = null;
  }

  function getImageRecoveryScope(img) {
    if (!img) return null;
    return img.closest(
      IMAGE_SCOPE_SELECTOR
    ) || img.parentElement || null;
  }

  function findRecoveryTargetImage(img) {
    if (!img) return null;
    const scope = getImageRecoveryScope(img);
    if (!scope) return img.isConnected ? img : null;

    const imgs = Array.from(scope.querySelectorAll('img'));
    if (!imgs.length) return img.isConnected ? img : null;

    if (scope.hasAttribute?.('data-mt-card-fixed') || scope.matches?.('.card, article, li, .product-card, .recommend-product-item, .product-item, .grid__item')) {
      return pickPrimaryCardImage(imgs) || imgs[0] || null;
    }

    return imgs.find(imageNodeLooksUsable) || imgs[0] || null;
  }

  function bindDesiredImageState(img, data, desired) {
    if (!img) return;
    img.__mtDesiredData = data;
    img.__mtDesiredSources = desired;

    if (img.__mtDesiredStateBound) return;
    img.__mtDesiredStateBound = true;

    img.addEventListener('load', () => {
      const latestDesired = img.__mtDesiredSources;
      const latestData = img.__mtDesiredData;
      if (!latestDesired || !latestData) return;
      const loadedAbs = getAbsoluteImageUrl(img.currentSrc || img.src || '');
      if (loadedAbs === latestDesired.primaryAbs && latestDesired.primaryUrl) {
        setImageUrlVerdict(latestDesired.primaryUrl, 'ok');
        setApplyVerdict(latestData, 'primary');
        clearImageRecoveryTimer(img);
        return;
      }
      if (loadedAbs === latestDesired.bricklinkAbs && latestDesired.bricklinkUrl) {
        setImageUrlVerdict(latestDesired.bricklinkUrl, 'ok');
        setApplyVerdict(latestData, 'fallback');
        clearImageRecoveryTimer(img);
      }
    });

    img.addEventListener('error', () => {
      const latestDesired = img.__mtDesiredSources;
      if (!latestDesired) return;
      const failedAbs = getAbsoluteImageUrl(img.currentSrc || img.src || '');
      if (failedAbs === latestDesired.primaryAbs && latestDesired.primaryUrl) {
        setImageUrlVerdict(latestDesired.primaryUrl, 'fail');
      }
      if (failedAbs === latestDesired.bricklinkAbs && latestDesired.bricklinkUrl) {
        setImageUrlVerdict(latestDesired.bricklinkUrl, 'fail');
      }
    });
  }

  function armImageRecovery(img, data, attempt = 1) {
    if (!img || !data || attempt > IMAGE_RECOVERY_MAX_ATTEMPTS) return;

    clearImageRecoveryTimer(img);
    img.__mtRecoveryTimer = setTimeout(() => {
      img.__mtRecoveryTimer = null;
      const target = findRecoveryTargetImage(img);
      if (!target) return;
      if (hasDesiredLoadedImage(target, data)) return;
      attachImageFallback(target, data);
      armImageRecovery(target, data, attempt + 1);
    }, IMAGE_RECOVERY_DELAY_MS * attempt);
  }

  function attachImageFallback(img, data) {
    if (!img || !data) return;

    const officialId = (data.officialId || '').trim();
    const primaryUrl = (data.imageUrl || '').trim();
    const bricklinkUrl = officialId
      ? `https://img.bricklink.com/ItemImage/SN/0/${officialId}-1.png`
      : '';

    if (!primaryUrl && !bricklinkUrl) return;

    const desired = getDesiredImageSources(data);
    bindDesiredImageState(img, data, desired);
    if (hasDesiredLoadedImage(img, data)) {
      const loadedAbs = getAbsoluteImageUrl(img.currentSrc || img.src || '');
      if (loadedAbs === desired.primaryAbs && primaryUrl) setImageUrlVerdict(primaryUrl, 'ok');
      if (loadedAbs === desired.bricklinkAbs && bricklinkUrl) setImageUrlVerdict(bricklinkUrl, 'ok');
      return;
    }

    function nukeSrcset(el) {
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      el.removeAttribute('data-sizes');
    }

    function bust(url) {
      try {
        const u = new URL(url, location.href);
        u.searchParams.set('mtb', String(Date.now()));
        return u.toString();
      } catch {
        const sep = url.includes('?') ? '&' : '?';
        return url + sep + 'mtb=' + Date.now();
      }
    }

    function currentAbs() {
      return getAbsoluteImageUrl(img.currentSrc || img.src || '');
    }

    function isLoadedOk(el) {
      return !!(el && el.complete && el.naturalWidth > 0);
    }

    function swapTo(url, verdict) {
      if (!url) return false;
      nukeSrcset(img);
      img.__mtRequestedVerdict = verdict;
      img.__mtRequestedUrl = url;
      img.src = url;
      return true;
    }

    function preload(url, timeoutMs = 1200) {
      return new Promise(resolve => {
        if (!url) {
          resolve(false);
          return;
        }

        const tester = new Image();
        let done = false;
        const finish = ok => {
          if (done) return;
          done = true;
          tester.onload = null;
          tester.onerror = null;
          clearTimeout(timer);
          resolve(ok);
        };

        const timer = setTimeout(() => finish(false), timeoutMs);
        tester.onload = () => finish(!!tester.naturalWidth);
        tester.onerror = () => finish(false);
        tester.decoding = 'async';
        tester.referrerPolicy = 'no-referrer';
        tester.src = url;
      });
    }

    const applyToken = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    img.__mtApplyToken = applyToken;

    const knownPrimaryVerdict = getImageUrlVerdict(primaryUrl);
    const knownFallbackVerdict = getImageUrlVerdict(bricklinkUrl);
    const knownApplyVerdict = getApplyVerdict(data);

    const primaryCandidates = [];
    const fallbackCandidates = [];

    if (primaryUrl) {
      if (knownPrimaryVerdict === 'ok') primaryCandidates.push(primaryUrl);
      primaryCandidates.push(primaryUrl);
      primaryCandidates.push(bust(primaryUrl));
    }

    if (bricklinkUrl) {
      if (knownFallbackVerdict === 'ok' || knownApplyVerdict === 'fallback' || knownPrimaryVerdict === 'fail') {
        fallbackCandidates.push(bricklinkUrl);
      }
      fallbackCandidates.push(bricklinkUrl);
      fallbackCandidates.push(bust(bricklinkUrl));
    }

    const unique = arr => Array.from(new Set(arr.filter(Boolean)));
    const primaryList = unique(primaryCandidates);
    const fallbackList = unique(fallbackCandidates);

    if (knownPrimaryVerdict === 'ok' && primaryUrl && currentAbs() !== desired.primaryAbs) {
      swapTo(primaryUrl, 'primary');
      armImageRecovery(img, data, 1);
      return;
    }
    if ((knownFallbackVerdict === 'ok' || knownApplyVerdict === 'fallback') && bricklinkUrl && currentAbs() !== desired.bricklinkAbs) {
      swapTo(bricklinkUrl, 'fallback');
      armImageRecovery(img, data, 1);
      return;
    }

    armImageRecovery(img, data, 1);

    (async () => {
      for (const url of primaryList) {
        const ok = await preload(url, url === primaryUrl ? 1000 : 1200);
        if (img.__mtApplyToken !== applyToken) return;
        if (ok) {
          swapTo(url, 'primary');
          return;
        }
      }

      if (primaryUrl) setImageUrlVerdict(primaryUrl, 'fail');

      for (const url of fallbackList) {
        const ok = await preload(url, url === bricklinkUrl ? 900 : 1100);
        if (img.__mtApplyToken !== applyToken) return;
        if (ok) {
          swapTo(url, 'fallback');
          return;
        }
      }

      if (bricklinkUrl) setImageUrlVerdict(bricklinkUrl, 'fail');

      if (img.__mtApplyToken !== applyToken) return;

      if (!isLoadedOk(img) || !imageMatchesDesiredSource(img, data)) {
        if (bricklinkUrl) {
          swapTo(bust(bricklinkUrl), 'fallback');
          return;
        }
        if (primaryUrl) {
          swapTo(bust(primaryUrl), 'primary');
        }
      }
    })();
  }

  function markWrapperFixed(wrapper) {
    if (!wrapper) return;
    wrapper.setAttribute('data-mt-wrapper-fixed', '1');
    if (getComputedStyle(wrapper).position === 'static') {
      wrapper.style.position = 'relative';
    }
  }

  function applyContainCenterFit(img) {
    if (!img) return;
    const wrapper =
      img.parentElement ||
      img.closest('.card__media, .product-card__image, .media, .product__media') ||
      img;

    ensureNoFlickerCSS();

    if (wrapper) {
      markWrapperFixed(wrapper);
      wrapper.style.display = 'flex';
      wrapper.style.alignItems = 'center';
      wrapper.style.justifyContent = 'center';
    }

    img.setAttribute('data-mt-contain-fit', '1');
  }

  function removeZoomClasses(node) {
    const zoomClasses = [
      'card--media-hover', 'media--hover', 'hover-zoom', 'image-hover', 'hover-effect',
      'zoom', 'zoom-image', 'zoom-on-hover', 'media--cropped',
      'media--square', 'media--landscape', 'media--portrait'
    ];
    zoomClasses.forEach(className => node.classList?.remove(className));
  }

  function ensureNoFlickerCSS() {
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

    [data-mt-card-fixed] .block-product-image__image,
    [data-mt-card-fixed] .recommend-product-item-image img,
    [data-mt-card-fixed] .recommend-product-item-image-media img,
    [data-mt-card-fixed] .card__media img,
    [data-mt-card-fixed] .product-card__image img,
    [data-mt-card-fixed] .media img,
    [data-mt-card-fixed] img {
      display: block !important;
      opacity: 1 !important;
      visibility: visible !important;
    }

    [data-mt-wrapper-fixed] {
      overflow: hidden !important;
      transform: none !important;
    }

    img[data-mt-contain-fit] {
      position: absolute !important;
      inset: 0 !important;
      margin: auto !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      transform: none !important;
      width: 100% !important;
      height: 100% !important;
      max-width: 100% !important;
      max-height: 100% !important;
      object-fit: contain !important;
      object-position: center center !important;
      transition: none !important;
      will-change: auto !important;
    }

    img[data-mt-cart-fit] {
      object-fit: contain !important;
      object-position: center center !important;
      width: 100% !important;
      height: auto !important;
      max-height: 160px !important;
      transform: none !important;
      transition: none !important;
    }

    img[data-mt-product-fit] {
      object-fit: contain !important;
      object-position: center center !important;
      opacity: 1 !important;
      visibility: visible !important;
      display: block !important;
      transform: none !important;
      transition: none !important;
      width: 100% !important;
      height: 100% !important;
      max-width: 100% !important;
      max-height: 70vh !important;
      margin: 0 auto !important;
    }

    [data-mt-product-wrapper] {
      overflow: hidden !important;
      max-height: 70vh !important;
      min-height: 320px !important;
    }

    [data-mt-card-fixed] .block-product-image__image:not([data-mt-primary-image]),
    [data-mt-card-fixed] .recommend-product-item-image img:not([data-mt-primary-image]),
    [data-mt-card-fixed] .recommend-product-item-image-media img:not([data-mt-primary-image]),
    [data-mt-card-fixed] .card__media img:not([data-mt-primary-image]),
    [data-mt-card-fixed] .product-card__image img:not([data-mt-primary-image]),
    [data-mt-card-fixed] .media img:not([data-mt-primary-image]),
    [data-mt-card-fixed] img:not([data-mt-primary-image]) {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    [data-mt-bg-cleared] {
      background-image: none !important;
      transform: none !important;
    }
    `;

    const style = document.createElement('style');
    style.id = 'mt-no-flicker-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function applyNoFlickerCSSForCard(card) {
    if (!card) return;
    card.setAttribute('data-mt-no-flicker', '1');
    card.setAttribute('data-mt-card-fixed', '1');
    ensureNoFlickerCSS();
  }

  function getCardImageNodes(card) {
    if (!card) return null;
    if (card.__mtImageNodes) return card.__mtImageNodes;

    const wrappers = [card, ...card.querySelectorAll(CARD_MEDIA_SELECTORS)];
    const bundle = {
      wrappers: Array.from(new Set(wrappers.filter(Boolean))),
      imgs: Array.from(card.querySelectorAll('img')),
      sources: Array.from(card.querySelectorAll('picture source')),
      bgEls: Array.from(card.querySelectorAll(CARD_BG_RESET_SELECTOR)),
    };

    card.__mtImageNodes = bundle;
    return bundle;
  }

  function getImageApplyKey(data) {
    const officialId = (data?.officialId || '').trim();
    const imageUrl = (data?.imageUrl || '').trim();
    return `${officialId}|${imageUrl}`;
  }

  function getDesiredImageSources(data) {
    const officialId = (data?.officialId || '').trim();
    const primaryUrl = (data?.imageUrl || '').trim();
    const bricklinkUrl = officialId
      ? `https://img.bricklink.com/ItemImage/SN/0/${officialId}-1.png`
      : '';

    return {
      primaryUrl,
      bricklinkUrl,
      primaryAbs: getAbsoluteImageUrl(primaryUrl),
      bricklinkAbs: getAbsoluteImageUrl(bricklinkUrl),
    };
  }

  function imageMatchesDesiredSource(img, data) {
    if (!img) return false;
    const { primaryAbs, bricklinkAbs } = getDesiredImageSources(data);
    const currentAbs = getAbsoluteImageUrl(
      img.currentSrc ||
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      ''
    );

    if (!currentAbs) return false;
    return (!!primaryAbs && currentAbs.startsWith(primaryAbs)) || (!!bricklinkAbs && currentAbs.startsWith(bricklinkAbs));
  }

  function hasDesiredLoadedImage(img, data) {
    if (!img || !data) return false;

    const primaryUrl = data.imageUrl || '';
    const officialId = (data.officialId || '').trim();
    const bricklinkUrl = officialId
      ? `https://img.bricklink.com/ItemImage/SN/0/${officialId}-1.png`
      : '';

    return isImageLoadedForUrl(img, primaryUrl) || isImageLoadedForUrl(img, bricklinkUrl);
  }

  function imageNodeLooksUsable(img) {
    if (!img) return false;
    const src = String(
      img.currentSrc ||
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      ''
    ).trim().toLowerCase();
    const cls = String(img.className || '').toLowerCase();

    if (!src && !img.complete) return false;
    if (src.startsWith('data:') && (src.includes('gif') || src.includes('svg'))) return false;
    if (cls.includes('placeholder') || cls.includes('lazyload-placeholder') || cls.includes('spinner')) return false;

    return true;
  }

  function pickPrimaryCardImage(imgs) {
    if (!Array.isArray(imgs) || !imgs.length) return null;

    for (const img of imgs) {
      if (imageNodeLooksUsable(img)) return img;
    }

    return imgs[0] || null;
  }

  function applyNoFlickerCSSForBgElement(el) {
    if (!el) return;
    el.setAttribute('data-mt-bg-cleared', '1');
  }

  function setCardImage(card, data) {
    if (!card) return;

    const applyKey = getImageApplyKey(data);
    const nodes = getCardImageNodes(card);
    if (!nodes || !nodes.imgs.length) return;

    const primaryImg = pickPrimaryCardImage(nodes.imgs);
    const hasDesiredImage = hasDesiredLoadedImage(primaryImg, data);

    if (!primaryImg) return;

    if (applyKey && card.getAttribute(CARD_IMAGE_APPLIED_ATTR) === applyKey && hasDesiredImage) {
      return;
    }

    applyNoFlickerCSSForCard(card);
    removeZoomClasses(card);

    nodes.wrappers.forEach(markWrapperFixed);

    nodes.sources.forEach(source => {
      source.srcset = '';
      source.removeAttribute('sizes');
      source.removeAttribute('srcset');
      source.style.display = 'none';
    });
    nodes.bgEls.forEach(applyNoFlickerCSSForBgElement);

    nodes.imgs.forEach(node => node.removeAttribute('data-mt-primary-image'));

    primaryImg.setAttribute('data-mt-primary-image', '1');
    primaryImg.style.display = 'block';
    primaryImg.style.visibility = 'visible';
    primaryImg.style.opacity = '1';
    attachImageFallback(primaryImg, data);

    if (data.name) primaryImg.alt = data.name;
    applyContainCenterFit(primaryImg);

    nodes.imgs.forEach(node => {
      if (node === primaryImg) return;
      node.removeAttribute('srcset');
      node.removeAttribute('sizes');
    });

    if (applyKey) {
      card.setAttribute(CARD_IMAGE_APPLIED_ATTR, applyKey);
    }
  }

  function setCartImage(container, data) {
    if (!container) return;
    const img = container.querySelector('img');
    if (!img) return;

    const applyKey = getImageApplyKey(data);
    const hasDesiredImage = hasDesiredLoadedImage(img, data);
    if (applyKey && img.getAttribute(CART_IMAGE_APPLIED_ATTR) === applyKey && hasDesiredImage) {
      return;
    }

    ensureNoFlickerCSS();

    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('data-sizes');

    attachImageFallback(img, data);

    if (data.name) img.alt = data.name;
    img.style.display = 'block';
    img.style.visibility = 'visible';
    img.style.opacity = '1';
    img.setAttribute('data-mt-cart-fit', '1');

    if (applyKey) {
      img.setAttribute(CART_IMAGE_APPLIED_ATTR, applyKey);
    }
  }

  function isProbablyProductUiImage(img) {
    if (!img) return false;
    const alt = (img.getAttribute('alt') || '').toLowerCase();
    const src = (img.getAttribute('src') || img.currentSrc || '').toLowerCase();
    const cls = ((img.className && String(img.className)) || '').toLowerCase();

    if (alt.includes('icon') || alt.includes('logo') || alt.includes('payment')) return false;
    if (src.includes('icon') || src.includes('logo') || src.includes('avatar')) return false;
    if (cls.includes('icon') || cls.includes('logo') || cls.includes('lazyload-placeholder')) return false;
    return true;
  }

  function scoreProductImageCandidate(img) {
    if (!img || !isProbablyProductUiImage(img)) return -1;

    const rect = img.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area < 20000) return -1;

    let score = area;
    const main = document.querySelector('main') || document.body;
    const h1 = main.querySelector(DOM_SELECTORS.productTitle);

    if (h1) {
      const imgTop = rect.top + window.scrollY;
      const h1Top = h1.getBoundingClientRect().top + window.scrollY;
      if (imgTop <= h1Top + 250) score += 500000;
      const sameSection = img.closest('section, .product, .product__info-wrapper, .product__media-wrapper, .page-width');
      if (sameSection && h1.closest('section, .product, .product__info-wrapper, .product__media-wrapper, .page-width') === sameSection) {
        score += 250000;
      }
    }

    const src = (img.currentSrc || img.src || '').toLowerCase();
    if (src.includes('/products/')) score += 100000;
    if (img.closest(PRODUCT_MEDIA_SCOPE_SELECTOR)) {
      score += 300000;
    }

    return score;
  }

  function findPrimaryProductImageCandidates() {
    const main = document.querySelector('main') || document.body;
    const allImgs = Array.from(main.querySelectorAll('img')).filter(isProbablyProductUiImage);
    const scored = allImgs
      .map(img => ({ img, score: scoreProductImageCandidate(img) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return [];

    const topScore = scored[0].score;
    const candidates = scored
      .filter(item => item.score >= topScore - 250000)
      .map(item => item.img);

    return Array.from(new Set(candidates));
  }

  function forceProductImageElement(img, data) {
    if (!img || !data) return;

    const applyKey = getImageApplyKey(data);
    const hasDesiredImage = hasDesiredLoadedImage(img, data);
    if (applyKey && img.getAttribute(PRODUCT_IMAGE_APPLIED_ATTR) === applyKey && hasDesiredImage) {
      return;
    }

    ensureNoFlickerCSS();

    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('data-sizes');
    if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
      img.parentElement.querySelectorAll('source').forEach(source => {
        source.srcset = '';
        source.removeAttribute('srcset');
        source.removeAttribute('sizes');
      });
    }

    const wrapper =
      img.closest(PRODUCT_MEDIA_SCOPE_SELECTOR) ||
      img.parentElement;

    if (wrapper) {
      markWrapperFixed(wrapper);
      wrapper.setAttribute('data-mt-product-wrapper', '1');
    }

    if (data.name) img.alt = data.name;
    img.style.display = 'block';
    img.style.visibility = 'visible';
    img.style.opacity = '1';
    img.setAttribute('data-mt-product-fit', '1');

    attachImageFallback(img, data);

    if (applyKey) {
      img.setAttribute(PRODUCT_IMAGE_APPLIED_ATTR, applyKey);
    }
  }

  function startStubbornProductImageLock(data) {
    const imgs = findPrimaryProductImageCandidates();
    if (!imgs.length) return;

    forceProductImageElement(imgs[0], data);
  }

  global.MarstoyImages = {
    getAbsoluteImageUrl,
    attachImageFallback,
    setCardImage,
    setCartImage,
    startStubbornProductImageLock,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
