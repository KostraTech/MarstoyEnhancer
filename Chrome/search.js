(function (global) {
  const { MESSAGE_TYPES, STORAGE_KEYS } = global.MarstoyShared;
  const { extensionAlive, storageGet, storageSet, getLastError } = global.MarstoyRuntime;

  let marstoyCacheIndex = [];
  let marstoyThemeOptions = [];
  let marstoyYearOptions = [];

  const marstoyCacheFilters = {
    theme: '',
    year: '',
  };

  let searchUIInitialized = false;
  let syncStatus = '';
  let syncTimeoutHandle = null;
  let lastLoadedIndexStamp = null;
  let lastSyncClickAt = 0;
  let countdownIntervalHandle = null;
  let countdownRemaining = 0;
  let inputElRef = null;
  let searchBtnRef = null;
  let resultBoxRef = null;
  let themeSelectRef = null;
  let yearSelectRef = null;
  let syncStatusBoxRef = null;
  let syncBtnRef = null;

  const ME_SEARCH_POSITION_KEY = STORAGE_KEYS.meSearchPosition;
  const ME_SEARCH_DEFAULT_OFFSET = 16;
  const ME_SEARCH_MIN_VISIBLE_BOTTOM = 44;
  const SYNC_STATUS_DEFAULT_CLASS = 'mt-sync-status-default';
  const SYNC_STATUS_DONE_CLASS = 'mt-sync-status-done';
  let meSearchDragBound = false;

  function getEstimatedExpandedMeSearchHeight() {
    const wrap = document.getElementById('mt-marstoy-wrapper');
    const baseHeight = (wrap && wrap.offsetHeight) || 220;
    const resultsEl = document.getElementById('mt-marstoy-results');
    const resultsMarginTop = 8;
    const resultsBorderAllowance = 2;
    const resultsMaxHeight = 260;

    if (resultsEl && resultsEl.style.display !== 'none') {
      return baseHeight;
    }

    return baseHeight + resultsMarginTop + resultsBorderAllowance + resultsMaxHeight;
  }

  function getMeSearchDefaultPosition() {
    const wrap = document.getElementById('mt-marstoy-wrapper');
    const width = (wrap && wrap.offsetWidth) || 320;
    const height = getEstimatedExpandedMeSearchHeight();
    return {
      left: ME_SEARCH_DEFAULT_OFFSET,
      top: Math.max(ME_SEARCH_DEFAULT_OFFSET, window.innerHeight - height - ME_SEARCH_DEFAULT_OFFSET),
    };
  }

  function clampMeSearchPosition(left, top) {
    const wrap = document.getElementById('mt-marstoy-wrapper');
    const width = (wrap && wrap.offsetWidth) || 320;
    const maxLeft = Math.max(ME_SEARCH_DEFAULT_OFFSET, window.innerWidth - width - ME_SEARCH_DEFAULT_OFFSET);
    const maxTop = Math.max(ME_SEARCH_DEFAULT_OFFSET, window.innerHeight - ME_SEARCH_MIN_VISIBLE_BOTTOM);

    const safeLeft = Math.min(Math.max(ME_SEARCH_DEFAULT_OFFSET, Number(left) || ME_SEARCH_DEFAULT_OFFSET), maxLeft);
    const safeTop = Math.min(Math.max(ME_SEARCH_DEFAULT_OFFSET, Number(top) || ME_SEARCH_DEFAULT_OFFSET), maxTop);

    return { left: safeLeft, top: safeTop };
  }

  function applyMeSearchPosition(left, top) {
    const wrap = document.getElementById('mt-marstoy-wrapper');
    if (!wrap) return;

    const pos = clampMeSearchPosition(left, top);
    wrap.style.left = `${pos.left}px`;
    wrap.style.top = `${pos.top}px`;
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
  }

  async function loadAndApplyMeSearchPosition() {
    const wrap = document.getElementById('mt-marstoy-wrapper');
    if (!wrap) return;

    const res = await storageGet([ME_SEARCH_POSITION_KEY]);
    const saved = res[ME_SEARCH_POSITION_KEY];
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      applyMeSearchPosition(saved.left, saved.top);
      return;
    }

    const pos = getMeSearchDefaultPosition();
    applyMeSearchPosition(pos.left, pos.top);
  }

  async function saveCurrentMeSearchPosition() {
    const wrap = document.getElementById('mt-marstoy-wrapper');
    if (!wrap) return;

    const left = parseFloat(wrap.style.left);
    const top = parseFloat(wrap.style.top);
    const pos = clampMeSearchPosition(left, top);
    applyMeSearchPosition(pos.left, pos.top);
    await storageSet({ [ME_SEARCH_POSITION_KEY]: pos });
  }

  async function resetMeSearchPosition() {
    const pos = getMeSearchDefaultPosition();
    applyMeSearchPosition(pos.left, pos.top);
    await storageSet({ [ME_SEARCH_POSITION_KEY]: pos });
  }

  function bindMeSearchDragOnce() {
    if (meSearchDragBound) return;

    const wrap = document.getElementById('mt-marstoy-wrapper');
    const handle = document.getElementById('mt-drag-handle');
    if (!wrap || !handle) return;

    meSearchDragBound = true;
    handle.style.cursor = 'grab';
    handle.style.userSelect = 'none';

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMove = ev => {
      if (!dragging) return;
      applyMeSearchPosition(ev.clientX - offsetX, ev.clientY - offsetY);
    };

    const onUp = async () => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = 'grab';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      await saveCurrentMeSearchPosition();
    };

    handle.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      dragging = true;
      offsetX = ev.clientX - rect.left;
      offsetY = ev.clientY - rect.top;
      handle.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      ev.preventDefault();
    });
  }

  function bindRefreshClick() {
    const link = document.getElementById('mt-refresh-link');
    if (!link || link.dataset.mtBound === '1') return;
    link.dataset.mtBound = '1';
    link.addEventListener('click', () => {
      window.location.reload();
    }, { once: true });
  }

  function renderSyncDoneState(el) {
    if (!el) return;
    el.replaceChildren();

    const link = document.createElement('span');
    link.id = 'mt-refresh-link';
    link.className = 'mt-sync-status-link';
    link.textContent = '✅ Done. Refresh page';
    el.appendChild(link);
    bindRefreshClick();
  }

  function clearCountdownInterval() {
    if (countdownIntervalHandle) {
      clearInterval(countdownIntervalHandle);
      countdownIntervalHandle = null;
    }
  }

  function getSyncStatusBox() {
    if (!syncStatusBoxRef) {
      syncStatusBoxRef = document.getElementById('mt-sync-status-box');
    }
    return syncStatusBoxRef;
  }

  function setSyncStatusBoxClass(className = SYNC_STATUS_DEFAULT_CLASS) {
    const el = getSyncStatusBox();
    if (!el) return null;

    el.classList.remove(SYNC_STATUS_DEFAULT_CLASS, SYNC_STATUS_DONE_CLASS);
    el.classList.add(className);
    return el;
  }

  function resetSyncStatusBox() {
    const el = setSyncStatusBoxClass();
    if (!el) return null;
    el.textContent = '';
    return el;
  }

  function updateLoadingLabel() {
    if (syncStatus !== 'loading') return;

    const el = setSyncStatusBoxClass();
    if (!el) return;

    const suffix = countdownRemaining > 0 ? ` ${countdownRemaining}s` : '';
    el.textContent = `⏳ Syncing…${suffix}`;
  }

  function startCountdown(secondsTotal) {
    countdownRemaining = secondsTotal;
    updateLoadingLabel();
    clearCountdownInterval();
    countdownIntervalHandle = setInterval(() => {
      countdownRemaining -= 1;
      if (countdownRemaining <= 0) {
        clearCountdownInterval();
      }
      updateLoadingLabel();
    }, 1000);
  }

  function setSyncStatus(newState) {
    syncStatus = newState;

    const el = getSyncStatusBox();
    if (!el) return;

    if (syncStatus === 'loading') {
      startCountdown(20);
      return;
    }

    clearCountdownInterval();
    if (syncTimeoutHandle) clearTimeout(syncTimeoutHandle);

    if (syncStatus === 'done') {
      setSyncStatusBoxClass(SYNC_STATUS_DONE_CLASS);
      renderSyncDoneState(el);
      return;
    }

    resetSyncStatusBox();
  }

  function armSyncSafetyTimeout() {
    if (syncTimeoutHandle) {
      clearTimeout(syncTimeoutHandle);
    }
    syncTimeoutHandle = setTimeout(() => {
      if (syncStatus === 'loading') {
        setSyncStatus('done');
      }
    }, 20000);
  }

  async function marstoySearchLoadIndexNow(forceReload = false) {
    if (!extensionAlive()) {
      marstoyCacheIndex = [];
      marstoyThemeOptions = [];
      marstoyYearOptions = [];
      lastLoadedIndexStamp = null;
      return;
    }

    const stampRes = await storageGet([STORAGE_KEYS.allBrickKitsLastSync]);
    const nextStamp = stampRes[STORAGE_KEYS.allBrickKitsLastSync] || 0;
    if (!forceReload && lastLoadedIndexStamp === nextStamp && marstoyCacheIndex.length > 0) {
      return;
    }

    const res = await storageGet([STORAGE_KEYS.allBrickKits]);
    const list = res[STORAGE_KEYS.allBrickKits] || [];

    marstoyCacheIndex = list.map(item => ({
      officialId: item.officialId || '',
      storeId: item.storeId || '',
      name: item.name || '',
      year: item.year || '',
      themeName: item.themeName || '',
      url: item.url || '',
      _lc_officialId: (item.officialId || '').toLowerCase(),
      _lc_storeId: (item.storeId || '').toLowerCase(),
      _lc_name: (item.name || '').toLowerCase(),
      _lc_theme: (item.themeName || '').toLowerCase(),
    }));

    const themeSet = new Set();
    const yearSet = new Set();
    for (const item of marstoyCacheIndex) {
      if (item.themeName) themeSet.add(item.themeName);
      if (item.year) yearSet.add(item.year);
    }

    marstoyThemeOptions = Array.from(themeSet).sort((a, b) => a.localeCompare(b));
    marstoyYearOptions = Array.from(yearSet).sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb - na;
      if (!Number.isNaN(na)) return -1;
      if (!Number.isNaN(nb)) return 1;
      return a.localeCompare(b);
    });
    lastLoadedIndexStamp = nextStamp;
  }

  function marstoySearchFilter(query) {
    const q = (query || '').trim().toLowerCase();
    const wantTheme = marstoyCacheFilters.theme.trim().toLowerCase();
    const wantYear = marstoyCacheFilters.year.trim().toLowerCase();

    if (!q && !wantTheme && !wantYear) {
      return [];
    }

    return marstoyCacheIndex.filter(item => {
      const textMatch =
        !q ||
        item._lc_officialId.includes(q) ||
        item._lc_storeId.includes(q) ||
        item._lc_name.includes(q) ||
        item._lc_theme.includes(q);
      if (!textMatch) return false;
      if (wantTheme && (item.themeName || '').toLowerCase() !== wantTheme) return false;
      if (wantYear && (item.year || '').toLowerCase() !== wantYear) return false;
      return true;
    });
  }

  function buildSearchResultRow(item) {
    const row = document.createElement('div');
    row.className = 'mt-marstoy-result-row';
    row.dataset.url = item.url || '';
    row.dataset.storeId = item.storeId || '';
    row.dataset.officialId = item.officialId || '';

    const firstBits = [];
    if (item.officialId) firstBits.push(item.officialId);
    if (item.name) firstBits.push(item.name);
    if (item.year) firstBits.push(`(${item.year})`);
    const line1 = firstBits.join(' - ').replace(' - (', ' (');

    const titleEl = document.createElement('div');
    titleEl.className = 'mt-marstoy-result-title';
    titleEl.textContent = line1;
    row.appendChild(titleEl);

    const metaBits = [];
    if (item.themeName) metaBits.push(item.themeName);
    if (item.storeId) metaBits.push(item.storeId);
    const line2 = metaBits.join(' | ');

    if (line2) {
      const metaEl = document.createElement('div');
      metaEl.className = 'mt-marstoy-result-meta';
      metaEl.textContent = line2;
      row.appendChild(metaEl);
    }

    return row;
  }

  function marstoySearchRenderResults(matches) {
    const resultBox = resultBoxRef || document.getElementById('mt-marstoy-results');
    if (!resultBox) return;

    if (!matches || matches.length === 0) {
      resultBox.style.display = 'none';
      resultBox.innerHTML = '';
      return;
    }

    resultBox.style.display = 'block';
    resultBox.innerHTML = '';

    const frag = document.createDocumentFragment();
    matches.slice(0, 60).forEach(item => {
      frag.appendChild(buildSearchResultRow(item));
    });
    resultBox.appendChild(frag);
  }

  function getResultRowTargetUrl(row) {
    if (!row) return '';

    if (row.dataset.url) {
      return row.dataset.url;
    }
    if (row.dataset.storeId) {
      return `https://marstoy.com/products/${row.dataset.storeId.toLowerCase()}`;
    }

    const queryId = row.dataset.officialId || row.dataset.storeId || '';
    if (!queryId) return '';
    return `https://marstoy.com/collections/brick-kits?keyword=${encodeURIComponent(queryId)}`;
  }

  function gatherIdsForRedirect(matches) {
    const ids = [];
    for (const item of matches) {
      if (item.officialId) ids.push(item.officialId);
      else if (item.storeId) ids.push(item.storeId);
    }
    return Array.from(new Set(ids));
  }

  function handleEnterRedirect() {
    if (!inputElRef) return;
    const matches = marstoySearchFilter(inputElRef.value || '');
    if (!matches.length) return;

    const ids = gatherIdsForRedirect(matches);
    if (!ids.length) return;

    const keywordParam = encodeURIComponent(ids.join(' ')).replace(/%20/g, '+');
    window.location.href = `https://marstoy.com/collections/brick-kits?keyword=${keywordParam}`;
  }

  function fillSelectOptions(selectEl, options) {
    if (!selectEl) return;

    const frag = document.createDocumentFragment();
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'ALL';
    frag.appendChild(allOption);

    for (const option of options) {
      const optionEl = document.createElement('option');
      optionEl.value = option;
      optionEl.textContent = option;
      frag.appendChild(optionEl);
    }

    selectEl.replaceChildren(frag);
  }

  function populateDropdowns() {
    if (!themeSelectRef || !yearSelectRef) {
      themeSelectRef = document.getElementById('mt-theme-select');
      yearSelectRef = document.getElementById('mt-year-select');
    }
    if (!themeSelectRef || !yearSelectRef) return;

    fillSelectOptions(themeSelectRef, marstoyThemeOptions);
    fillSelectOptions(yearSelectRef, marstoyYearOptions);
    themeSelectRef.value = marstoyCacheFilters.theme || '';
    yearSelectRef.value = marstoyCacheFilters.year || '';
  }

  function ensureMeSearchCss() {
    if (document.getElementById('mt-me-search-css')) return;

    const style = document.createElement('style');
    style.id = 'mt-me-search-css';
    style.textContent = `
      #mt-marstoy-wrapper {
        position: fixed;
        bottom: 16px;
        left: 16px;
        z-index: 999999;
        font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,sans-serif;
        width: 320px;
        color: #fff;
        font-size: 14px;
        line-height: 1.4;
      }
      #mt-marstoy-box {
        background: #111;
        border: 1px solid #444;
        border-radius: 8px;
        padding: 10px 10px 12px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.75);
      }
      #mt-drag-handle {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 4px;
        cursor: grab;
        user-select: none;
      }
      .mt-me-search-title {
        flex: 0 0 auto;
        color: #ccc;
        font-size: 12px;
        font-weight: 500;
        line-height: 1.4;
        white-space: nowrap;
      }
      #mt-sync-status-box {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 11px;
        line-height: 1.2;
        color: #ccc;
        min-height: 1em;
        white-space: nowrap;
        text-align: center;
      }
      .mt-me-search-actions {
        flex: 0 0 auto;
        display: flex;
        align-items: flex-start;
        justify-content: flex-end;
        gap: 4px;
      }
      .mt-sync-status-default {
        color: #ccc;
        cursor: default;
        text-decoration: none;
      }
      .mt-sync-status-done {
        color: #7CFC7C;
        cursor: pointer;
        text-decoration: underline;
      }
      .mt-sync-status-link {
        color: inherit;
        text-decoration: inherit;
        cursor: inherit;
      }
      .mt-icon-btn {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        color: #aaa;
        line-height: 1.2;
        cursor: pointer;
        white-space: nowrap;
      }
      .mt-icon-btn:hover {
        color: #ddd;
      }
      #mt-reset-position-btn {
        font-size: 13px;
        padding: 4px 6px;
        min-width: 28px;
      }
      #mt-sync-btn {
        background: #1a1a1a;
        border: 1px solid #555;
        border-radius: 4px;
        color: #ccc;
        font-size: 11px;
        line-height: 1.2;
        padding: 4px 6px;
        cursor: pointer;
        white-space: nowrap;
        min-width: 40px;
      }
      #mt-sync-btn:hover {
        background: #242424;
        border-color: #666;
        color: #eee;
      }
      .mt-filter-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 6px;
        font-size: 12px;
        color: #ccc;
      }
      .mt-filter-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .mt-filter-label {
        flex: 0 0 90px;
        min-width: 90px;
        color: #aaa;
        font-size: 12px;
        line-height: 1.4;
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .mt-filter-field {
        flex: 1;
        min-width: 0;
      }
      .mt-filter-reset {
        background: none;
        border: 0;
        color: #888;
        font-size: 11px;
        cursor: pointer;
        padding: 0;
        text-decoration: underline;
      }
      .mt-filter-select,
      #mt-marstoy-input {
        width: 100%;
        box-sizing: border-box;
        background: #1a1a1a;
        color: #fff;
        border: 1px solid #444;
        outline: none;
      }
      .mt-filter-select {
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.4;
        padding: 4px 6px;
      }
      .mt-search-input-wrap {
        position: relative;
      }
      #mt-marstoy-input {
        border-radius: 6px;
        font-size: 14px;
        line-height: 1.4;
        padding: 8px 32px 8px 9px;
      }
      #mt-search-btn {
        position: absolute;
        top: 0;
        right: 0;
        height: 100%;
        background: transparent;
        border: 0;
        color: #ccc;
        cursor: pointer;
        font-size: 24px;
        line-height: 1;
        padding: 0 12px 0 10px;
      }
      #mt-marstoy-results {
        margin-top: 8px;
        max-height: 260px;
        overflow-y: auto;
        border: 1px solid #333;
        border-radius: 6px;
        background: #1a1a1a;
        display: none;
        font-size: 14px;
        line-height: 1.4;
      }
      .mt-marstoy-result-row {
        padding: 10px 12px;
        cursor: pointer;
        border-bottom: 1px solid #333;
      }
      .mt-marstoy-result-row:hover {
        background: #2a2a2a;
      }
      .mt-marstoy-result-title {
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.4;
      }
      .mt-marstoy-result-meta {
        color: #aaa;
        font-size: 12px;
        line-height: 1.3;
        margin-top: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  function createSearchUIIfNeeded() {
    if (document.getElementById('mt-marstoy-wrapper')) return;

    ensureMeSearchCss();

    const wrap = document.createElement('div');
    wrap.id = 'mt-marstoy-wrapper';
    wrap.innerHTML = `
      <div id="mt-marstoy-box">
        <div id="mt-drag-handle">
          <div class="mt-me-search-title">ME Search</div>
          <div id="mt-sync-status-box"></div>
          <div class="mt-me-search-actions">
            <button id="mt-reset-position-btn" class="mt-icon-btn" title="Reset position" aria-label="Reset position">↺</button>
            <button id="mt-sync-btn" title="Sync Marstoy product cache" aria-label="Sync Marstoy product cache">Sync</button>
          </div>
        </div>
        <div class="mt-filter-group">
          <div class="mt-filter-row">
            <div class="mt-filter-label">
              <button id="mt-reset-theme" class="mt-filter-reset">Reset</button>
              <span>Theme:</span>
            </div>
            <div class="mt-filter-field">
              <select id="mt-theme-select" class="mt-filter-select"><option value="">ALL</option></select>
            </div>
          </div>
          <div class="mt-filter-row">
            <div class="mt-filter-label">
              <button id="mt-reset-year" class="mt-filter-reset">Reset</button>
              <span>Year:</span>
            </div>
            <div class="mt-filter-field">
              <select id="mt-year-select" class="mt-filter-select"><option value="">ALL</option></select>
            </div>
          </div>
        </div>
        <div class="mt-search-input-wrap">
          <input id="mt-marstoy-input" type="text" placeholder="Search sets on Marstoy" />
          <button id="mt-search-btn" title="Search">⌕</button>
        </div>
        <div id="mt-marstoy-results"></div>
      </div>
    `;

    document.body.appendChild(wrap);
  }

  function renderNow() {
    if (!inputElRef || !resultBoxRef) {
      inputElRef = document.getElementById('mt-marstoy-input');
      resultBoxRef = document.getElementById('mt-marstoy-results');
    }
    if (!inputElRef || !resultBoxRef) return;
    marstoySearchRenderResults(marstoySearchFilter(inputElRef.value || ''));
  }

  function triggerMarstoySyncWithUI() {
    if (!extensionAlive()) return;

    lastSyncClickAt = Date.now();
    setSyncStatus('loading');
    armSyncSafetyTimeout();

    try {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.syncCollection }, () => {
        if (getLastError()) {
          setSyncStatus('');
        }
      });
    } catch {
      setSyncStatus('');
    }
  }

  async function maybeDoInitialSyncOnce() {
    if (!extensionAlive()) return;
    const data = await storageGet([STORAGE_KEYS.initialSyncDone]);
    const already = !!data[STORAGE_KEYS.initialSyncDone];
    if (already) return;

    await storageSet({ [STORAGE_KEYS.initialSyncDone]: true });
    triggerMarstoySyncWithUI();
  }

  function bindSearchUIListenersOnce() {
    inputElRef = document.getElementById('mt-marstoy-input');
    searchBtnRef = document.getElementById('mt-search-btn');
    resultBoxRef = document.getElementById('mt-marstoy-results');
    themeSelectRef = document.getElementById('mt-theme-select');
    yearSelectRef = document.getElementById('mt-year-select');
    const resetThemeBtn = document.getElementById('mt-reset-theme');
    const resetYearBtn = document.getElementById('mt-reset-year');
    const resetPositionBtn = document.getElementById('mt-reset-position-btn');
    syncBtnRef = document.getElementById('mt-sync-btn');
    syncStatusBoxRef = document.getElementById('mt-sync-status-box');

    if (!inputElRef || !resultBoxRef || !themeSelectRef || !yearSelectRef || !syncBtnRef) return;

    inputElRef.addEventListener('input', renderNow);
    inputElRef.addEventListener('focus', renderNow);
    inputElRef.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        handleEnterRedirect();
      }
    });

    if (searchBtnRef) {
      searchBtnRef.addEventListener('click', handleEnterRedirect);
    }

    themeSelectRef.addEventListener('change', () => {
      marstoyCacheFilters.theme = themeSelectRef.value || '';
      renderNow();
    });

    yearSelectRef.addEventListener('change', () => {
      marstoyCacheFilters.year = yearSelectRef.value || '';
      renderNow();
    });

    if (resetThemeBtn) {
      resetThemeBtn.addEventListener('click', () => {
        marstoyCacheFilters.theme = '';
        themeSelectRef.value = '';
        renderNow();
      });
    }

    if (resetYearBtn) {
      resetYearBtn.addEventListener('click', () => {
        marstoyCacheFilters.year = '';
        yearSelectRef.value = '';
        renderNow();
      });
    }

    if (resetPositionBtn) {
      resetPositionBtn.addEventListener('click', async ev => {
        ev.preventDefault();
        ev.stopPropagation();
        await resetMeSearchPosition();
      });
    }

    syncBtnRef.addEventListener('click', triggerMarstoySyncWithUI);

    resultBoxRef.addEventListener('click', ev => {
      const row = ev.target.closest('.mt-marstoy-result-row');
      if (!row || !resultBoxRef.contains(row)) return;
      const targetUrl = getResultRowTargetUrl(row);
      if (targetUrl) {
        window.location.href = targetUrl;
      }
    });

    const box = document.getElementById('mt-marstoy-box');
    document.addEventListener('click', ev => {
      if (!box || !resultBoxRef) return;
      if (!box.contains(ev.target)) {
        resultBoxRef.style.display = 'none';
      }
    });
  }

  async function marstoySearchInit() {
    if (!searchUIInitialized) {
      createSearchUIIfNeeded();
      await marstoySearchLoadIndexNow();
      populateDropdowns();
      bindSearchUIListenersOnce();
      await loadAndApplyMeSearchPosition();
      bindMeSearchDragOnce();
      renderNow();
      searchUIInitialized = true;
      await maybeDoInitialSyncOnce();
      return;
    }

    await marstoySearchLoadIndexNow();
    populateDropdowns();
    await loadAndApplyMeSearchPosition();
    bindMeSearchDragOnce();
    renderNow();
  }

  function setMeSearchVisible(shouldShow, options = {}) {
    const { resetPosition = false } = options;
    const wrap = document.getElementById('mt-marstoy-wrapper');

    if (shouldShow) {
      if (!wrap) {
        marstoySearchInit().then(() => {
          if (resetPosition) {
            resetMeSearchPosition();
          }
        });
      } else {
        wrap.style.display = 'block';
        if (resetPosition) {
          resetMeSearchPosition();
        }
      }
      return;
    }

    if (wrap) {
      if (resetPosition) {
        resetMeSearchPosition();
      }
      wrap.style.display = 'none';
    }
  }

  async function initMaybeShowSearch() {
    if (!extensionAlive()) return;
    chrome.storage.local.get([STORAGE_KEYS.showMeSearch], res => {
      const hasKey = Object.prototype.hasOwnProperty.call(res, STORAGE_KEYS.showMeSearch);
      const show = hasKey ? !!res[STORAGE_KEYS.showMeSearch] : true;
      if (show) {
        marstoySearchInit();
      }
    });
  }

  function handleCatalogStatus(msg) {
    const recentClick = (Date.now() - lastSyncClickAt) < 60000;
    if (!recentClick) return false;

    if (msg.error) {
      clearCountdownInterval();
      if (syncTimeoutHandle) clearTimeout(syncTimeoutHandle);
      setSyncStatus('');
      return true;
    }

    setSyncStatus('done');
    return true;
  }

  global.MarstoySearch = {
    initMaybeShowSearch,
    setMeSearchVisible,
    handleCatalogStatus,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
