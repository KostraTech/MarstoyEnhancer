(function () {
  const debugMode = false;
  let ranOnce = false;
  let lockedProductId = null;

  function logDebug(msg, data = null) {
    if (debugMode) {
      const ts = new Date().toISOString();
      console.log(`[${ts}] ${msg}`, data || '');
    }
  }

  // -------------------------------------------------
  // Extension context safety helpers
  // -------------------------------------------------

  function safeHasRuntime() {
    try {
      return typeof chrome !== "undefined" && chrome && chrome.runtime;
    } catch {
      return false;
    }
  }

  function safeHasRuntimeId() {
    try {
      return !!(safeHasRuntime() && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function safeHasStorage() {
    try {
      return (
        typeof chrome !== "undefined" &&
        chrome &&
        chrome.storage &&
        chrome.storage.local
      );
    } catch {
      return false;
    }
  }

  function extensionAlive() {
    return safeHasRuntime() && safeHasRuntimeId() && safeHasStorage();
  }

  // -------------------------------------------------
  // chrome.storage helpers
  // -------------------------------------------------

  function storageGet(keys) {
    if (!extensionAlive()) {
      logDebug('storageGet: extension not alive');
      return Promise.resolve({});
    }

    return new Promise(resolve => {
      try {
        chrome.storage.local.get(keys, (result) => {
          if (safeHasRuntime() && chrome.runtime.lastError) {
            logDebug('storage.get lastError:', chrome.runtime.lastError);
            resolve({});
          } else {
            resolve(result || {});
          }
        });
      } catch (e) {
        logDebug('storage.get threw:', e);
        resolve({});
      }
    });
  }

  function storageGetAll(keys) {
    return storageGet(keys);
  }

  function storageSet(obj) {
    if (!extensionAlive()) return Promise.resolve();
    return new Promise(resolve => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        logDebug('storage.set threw:', e);
        resolve();
      }
    });
  }

  function cacheKey(id) {
    return (id || '').toUpperCase().trim();
  }

  async function setCacheItem(productId, data) {
    if (!extensionAlive()) {
      logDebug('setCacheItem: extension not alive');
      return;
    }

    const key = cacheKey(productId);
    await storageSet({ [key]: { ...data, ts: Date.now() } });
  }

  async function getCacheItem(productId) {
    const key = cacheKey(productId);
    const obj = await storageGet([key]);
    return obj[key] || null;
  }

  // -------------------------------------------------
  // ID / catalog lookup logic
  // -------------------------------------------------

  function extractAnyIdFromText(text) {
    const m = (text || '').toUpperCase().match(/\b([MN]\d+)\b/);
    return m ? m[1] : null;
  }

  function extractAnyIdFromHref(href = '') {
    let x = href.match(/\/products\/.*?([mn]\d+)/i);
    if (x) return x[1].toUpperCase();

    let y = href.match(/([mn]\d+)/i);
    if (y) return y[1].toUpperCase();

    let n = href.match(/\/products\/(\d+)/i);
    if (n) return `M${n[1]}`.toUpperCase();

    return null;
  }

  function toOfficialId(mOrN) {
    const normalized = (mOrN || '').toUpperCase().trim();
    return normalized
      .slice(1)
      .split('')
      .reverse()
      .join('');
  }

  async function lookupFromCatalog(mOrN) {
    const officialId = toOfficialId(mOrN);
    if (!officialId) return null;

    const cached = await getCacheItem(mOrN);
    if (cached) return cached;

    if (!extensionAlive()) {
      logDebug('lookupFromCatalog: extension not alive');
      return null;
    }

    const entry = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { type: 'LOOKUP_SET', officialId },
          (resp) => {
            if (safeHasRuntime() && chrome.runtime.lastError) {
              logDebug('LOOKUP_SET lastError', chrome.runtime.lastError);
              resolve(null);
            } else {
              resolve(resp?.entry || null);
            }
          }
        );
      } catch (e) {
        logDebug('LOOKUP_SET threw', e);
        resolve(null);
      }
    });

    if (!entry) return null;
    await setCacheItem(mOrN, entry);
    return entry;
  }

  // ============================================================
  // ==== ME Search UI (search, filters, sync) ==================
  // ============================================================

  let marstoyCacheIndex = [];
  let marstoyThemeOptions = [];
  let marstoyYearOptions = [];

  const marstoyCacheFilters = {
    theme: "",
    year: ""
  };

  let searchUIInitialized = false;

  // sync state
  // syncStatus: "", "loading", "done"
  let syncStatus = "";
  let syncTimeoutHandle = null;
  let lastSyncClickAt = 0;

  // countdown
  let countdownIntervalHandle = null;
  let countdownRemaining = 0;

  // refs
  let inputElRef = null;
  let searchBtnRef = null;
  let resultBoxRef = null;
  let themeSelectRef = null;
  let yearSelectRef = null;
  let syncStatusBoxRef = null;
  let syncBtnRef = null;

  // helper: clickable refresh link after done
  function bindRefreshClick() {
    const link = document.getElementById("mt-refresh-link");
    if (!link) return;
    link.addEventListener(
      "click",
      () => {
        window.location.reload();
      },
      { once: true }
    );
  }

  function clearCountdownInterval() {
    if (countdownIntervalHandle) {
      clearInterval(countdownIntervalHandle);
      countdownIntervalHandle = null;
    }
  }

  function startCountdown(secondsTotal) {
    countdownRemaining = secondsTotal;
    updateLoadingLabel(); // draw first state
    clearCountdownInterval();
    countdownIntervalHandle = setInterval(() => {
      countdownRemaining = countdownRemaining - 1;
      if (countdownRemaining <= 0) {
        clearCountdownInterval();
      }
      updateLoadingLabel();
    }, 1000);
  }

  function updateLoadingLabel() {
    if (!syncStatusBoxRef) {
      syncStatusBoxRef = document.getElementById("mt-sync-status-box");
    }
    if (!syncStatusBoxRef) return;

    if (syncStatus === "loading") {
      const suffix = countdownRemaining > 0 ? ` ${countdownRemaining}s` : "";
      syncStatusBoxRef.textContent = `⏳ Syncing…${suffix}`;
      syncStatusBoxRef.style.color = "#ccc";
      syncStatusBoxRef.style.cursor = "default";
      syncStatusBoxRef.style.textDecoration = "none";
    }
  }

  function setSyncStatus(newState) {
    syncStatus = newState;

    if (!syncStatusBoxRef) {
      syncStatusBoxRef = document.getElementById("mt-sync-status-box");
    }
    if (!syncStatusBoxRef) return;

    if (syncStatus === "loading") {
      // begin countdown 20s
      startCountdown(20);
    } else if (syncStatus === "done") {
      clearCountdownInterval();
      if (syncTimeoutHandle) clearTimeout(syncTimeoutHandle);
      syncStatusBoxRef.innerHTML =
        `<span id="mt-refresh-link" style="color:#7CFC7C; text-decoration:underline; cursor:pointer;">✅ Refresh page for new data</span>`;
      syncStatusBoxRef.style.color = "#7CFC7C";
      syncStatusBoxRef.style.cursor = "pointer";
      syncStatusBoxRef.style.textDecoration = "underline";
      bindRefreshClick();
    } else {
      clearCountdownInterval();
      if (syncTimeoutHandle) clearTimeout(syncTimeoutHandle);
      syncStatusBoxRef.textContent = "";
      syncStatusBoxRef.style.color = "#ccc";
      syncStatusBoxRef.style.cursor = "default";
      syncStatusBoxRef.style.textDecoration = "none";
    }
  }

  // fallback timeout after Sync click (20s safety)
  function armSyncSafetyTimeout() {
    if (syncTimeoutHandle) {
      clearTimeout(syncTimeoutHandle);
    }
    syncTimeoutHandle = setTimeout(() => {
      if (syncStatus === "loading") {
        setSyncStatus("done"); // assume done anyway
      }
    }, 20000);
  }

  async function marstoySearchLoadIndexNow() {
    if (!extensionAlive()) {
      marstoyCacheIndex = [];
      marstoyThemeOptions = [];
      marstoyYearOptions = [];
      return;
    }

    const res = await storageGetAll(["ALL_BRICK_KITS"]);
    const list = res.ALL_BRICK_KITS || [];

    marstoyCacheIndex = list.map(item => ({
      officialId: item.officialId || "",
      storeId: item.storeId || "",
      name: item.name || "",
      year: item.year || "",
      themeName: item.themeName || "",
      url: item.url || "",
      _lc_officialId: (item.officialId || "").toLowerCase(),
      _lc_storeId: (item.storeId || "").toLowerCase(),
      _lc_name: (item.name || "").toLowerCase(),
      _lc_theme: (item.themeName || "").toLowerCase()
    }));

    const themeSet = new Set();
    const yearSet = new Set();
    for (const it of marstoyCacheIndex) {
      if (it.themeName) themeSet.add(it.themeName);
      if (it.year) yearSet.add(it.year);
    }

    marstoyThemeOptions = Array.from(themeSet).sort((a,b)=>a.localeCompare(b));

    // changed year sorting: newest (largest number) first
    marstoyYearOptions = Array.from(yearSet).sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) {
        return nb - na; // larger year (newer) goes first
      }
      if (!isNaN(na)) return -1;
      if (!isNaN(nb)) return 1;
      return a.localeCompare(b);
    });
  }

  function marstoySearchFilter(query) {
    const q = (query || "").trim().toLowerCase();
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

      if (wantTheme) {
        if ((item.themeName || "").toLowerCase() !== wantTheme) return false;
      }

      if (wantYear) {
        if ((item.year || "").toLowerCase() !== wantYear) return false;
      }

      return true;
    });
  }

  function marstoySearchRowHTML(item) {
    const firstBits = [];
    if (item.officialId) firstBits.push(item.officialId);
    if (item.name) firstBits.push(item.name);
    if (item.year) firstBits.push(`(${item.year})`);
    const line1 = firstBits.join(" - ").replace(" - (", " (");

    const metaBits = [];
    if (item.themeName) metaBits.push(item.themeName);
    if (item.storeId) metaBits.push(item.storeId);
    const line2 = metaBits.join(" | ");

    return `
      <div style="color:#fff;font-size:14px;font-weight:600;line-height:1.4;">${line1}</div>
      ${
        line2
          ? `<div style="color:#aaa;font-size:12px;line-height:1.3;margin-top:2px;">${line2}</div>`
          : ""
      }
    `;
  }

  function marstoySearchRenderResults(matches) {
    const resultBox = resultBoxRef || document.getElementById("mt-marstoy-results");
    if (!resultBox) return;

    if (!matches || matches.length === 0) {
      resultBox.style.display = "none";
      resultBox.innerHTML = "";
      return;
    }

    resultBox.style.display = "block";
    resultBox.innerHTML = "";

    matches.slice(0, 60).forEach(item => {
      const row = document.createElement("div");
      row.style.padding = "10px 12px";
      row.style.cursor = "pointer";
      row.style.borderBottom = "1px solid #333";
      row.innerHTML = marstoySearchRowHTML(item);

      row.addEventListener("mouseenter", () => {
        row.style.background = "#2a2a2a";
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });

      row.addEventListener("click", () => {
        let targetUrl = "";
        if (item.storeId) {
          targetUrl = "https://marstoy.com/products/" + item.storeId.toLowerCase();
        } else {
          const queryId = item.officialId || item.storeId || "";
          if (!queryId) return;
          const qParam = encodeURIComponent(queryId);
          targetUrl = "https://marstoy.com/collections/brick-kits?keyword=" + qParam;
        }
        window.location.href = targetUrl;
      });

      resultBox.appendChild(row);
    });
  }

  function gatherIdsForRedirect(matches) {
    const ids = [];
    for (const item of matches) {
      if (item.officialId) {
        ids.push(item.officialId);
      } else if (item.storeId) {
        ids.push(item.storeId);
      }
    }
    return Array.from(new Set(ids));
  }

  function handleEnterRedirect() {
    if (!inputElRef) return;
    const matches = marstoySearchFilter(inputElRef.value || "");
    if (!matches.length) return;
    const ids = gatherIdsForRedirect(matches);
    if (!ids.length) return;

    const keywordParam = encodeURIComponent(ids.join(" ")).replace(/%20/g, "+");
    const targetUrl =
      "https://marstoy.com/collections/brick-kits?keyword=" + keywordParam;
    window.location.href = targetUrl;
  }

  function buildOptions(optsArr) {
    let html = `<option value="">ALL</option>`;
    for (const opt of optsArr) {
      const esc = opt.replace(/"/g, "&quot;");
      html += `<option value="${esc}">${esc}</option>`;
    }
    return html;
  }

  function populateDropdowns() {
    if (!themeSelectRef || !yearSelectRef) {
      themeSelectRef = document.getElementById("mt-theme-select");
      yearSelectRef = document.getElementById("mt-year-select");
    }
    if (!themeSelectRef || !yearSelectRef) return;

    themeSelectRef.innerHTML = buildOptions(marstoyThemeOptions);
    yearSelectRef.innerHTML = buildOptions(marstoyYearOptions);

    themeSelectRef.value = marstoyCacheFilters.theme || "";
    yearSelectRef.value = marstoyCacheFilters.year || "";
  }

  function createSearchUIIfNeeded() {
    if (document.getElementById("mt-marstoy-wrapper")) return;

    const panelWidth = 320;
    const labelWidth = 90;

    const wrap = document.createElement("div");
    wrap.id = "mt-marstoy-wrapper";

    wrap.style.position = "fixed";
    wrap.style.bottom = "16px";
    wrap.style.right = "16px";
    wrap.style.zIndex = "999999";
    wrap.style.fontFamily = "system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,sans-serif";
    wrap.style.width = panelWidth + "px";
    wrap.style.color = "#fff";
    wrap.style.fontSize = "14px";
    wrap.style.lineHeight = "1.4";

    wrap.innerHTML = `
      <div id="mt-marstoy-box" style="
        background:#111;
        border:1px solid #444;
        border-radius:8px;
        padding:10px 10px 12px;
        box-shadow:0 12px 32px rgba(0,0,0,0.75);
      ">

        <!-- header row -->
        <div style="
          display:flex;
          align-items:flex-start;
          justify-content:space-between;
          gap:8px;
          flex-wrap:wrap;
          margin-bottom:4px;
        ">
          <div style="
            flex:0 0 auto;
            color:#ccc;
            font-size:12px;
            font-weight:500;
            line-height:1.4;
            white-space:nowrap;
          ">
            ME Search
          </div>

          <div id="mt-sync-status-box" style="
            flex:1 1 auto;
            min-width:0;
            font-size:11px;
            line-height:1.2;
            color:#ccc;
            min-height:1em;
            white-space:nowrap;
            text-align:center;
          "></div>

          <div style="
            flex:0 0 auto;
            display:flex;
            align-items:flex-start;
            justify-content:flex-end;
          ">
            <button id="mt-sync-btn" style="
              background:#1a1a1a;
              border:1px solid #555;
              border-radius:4px;
              color:#ccc;
              font-size:11px;
              line-height:1.2;
              padding:4px 6px;
              cursor:pointer;
              white-space:nowrap;
              min-width:40px;
            ">Sync</button>
          </div>
        </div>

        <!-- filters -->
        <div style="
          display:flex;
          flex-direction:column;
          gap:4px;
          margin-bottom:6px;
          font-size:12px;
          color:#ccc;
        ">

          <div style="display:flex;align-items:flex-start;gap:8px;">
            <div style="
              flex:0 0 ${labelWidth}px;
              min-width:${labelWidth}px;
              color:#aaa;
              font-size:12px;
              line-height:1.4;
              display:flex;
              align-items:center;
              gap:6px;
              white-space:nowrap;
            ">
              <button id="mt-reset-theme" style="
                background:none;border:0;color:#888;font-size:11px;cursor:pointer;padding:0;text-decoration:underline;
              ">Reset</button>
              <span>Theme:</span>
            </div>
            <div style="flex:1;min-width:0;">
              <select id="mt-theme-select" style="
                width:100%;
                background:#1a1a1a;
                color:#fff;
                border:1px solid #444;
                border-radius:4px;
                font-size:12px;
                line-height:1.4;
                padding:4px 6px;
                outline:none;
              ">
                <option value="">ALL</option>
              </select>
            </div>
          </div>

          <div style="display:flex;align-items:flex-start;gap:8px;">
            <div style="
              flex:0 0 ${labelWidth}px;
              min-width:${labelWidth}px;
              color:#aaa;
              font-size:12px;
              line-height:1.4;
              display:flex;
              align-items:center;
              gap:6px;
              white-space:nowrap;
            ">
              <button id="mt-reset-year" style="
                background:none;border:0;color:#888;font-size:11px;cursor:pointer;padding:0;text-decoration:underline;
              ">Reset</button>
              <span>Year:</span>
            </div>
            <div style="flex:1;min-width:0;">
              <select id="mt-year-select" style="
                width:100%;
                background:#1a1a1a;
                color:#fff;
                border:1px solid #444;
                border-radius:4px;
                font-size:12px;
                line-height:1.4;
                padding:4px 6px;
                outline:none;
              ">
                <option value="">ALL</option>
              </select>
            </div>
          </div>

        </div>

        <!-- search box -->
        <div style="position:relative;">
          <input
            id="mt-marstoy-input"
            type="text"
            placeholder="Search sets on Marstoy"
            style="
              width:100%;
              box-sizing:border-box;
              border:1px solid #444;
              background:#1a1a1a;
              color:#fff;
              border-radius:6px;
              font-size:14px;
              line-height:1.4;
              padding:8px 32px 8px 9px;
              outline:none;
            "
          />
          <button
            id="mt-search-btn"
            style="
              position:absolute;
              top:0;
              right:0;
              height:100%;
              background:transparent;
              border:0;
              color:#ccc;
              cursor:pointer;
              font-size:24px;
              line-height:1;
              padding:0 12px 0 10px;
            "
            title="Search"
          >
            ⌕
          </button>
        </div>

        <div id="mt-marstoy-results" style="
          margin-top:8px;
          max-height:260px;
          overflow-y:auto;
          border:1px solid #333;
          border-radius:6px;
          background:#1a1a1a;
          display:none;
          font-size:14px;
          line-height:1.4;
        "></div>
      </div>
    `;

    document.body.appendChild(wrap);
  }

  function renderNow() {
    if (!inputElRef || !resultBoxRef) {
      inputElRef = document.getElementById("mt-marstoy-input");
      resultBoxRef = document.getElementById("mt-marstoy-results");
    }
    if (!inputElRef) return;
    const matches = marstoySearchFilter(inputElRef.value || "");
    marstoySearchRenderResults(matches);
  }

  // fire a sync request (shared by manual click + auto first-run)
  function triggerMarstoySyncWithUI() {
    if (!extensionAlive()) return;

    lastSyncClickAt = Date.now();
    setSyncStatus("loading"); // starts countdown
    armSyncSafetyTimeout();   // fallback after 20s

    try {
      chrome.runtime.sendMessage({ type: "SYNC_COLLECTION" }, () => {
        if (safeHasRuntime() && chrome.runtime.lastError) {
          // immediate fail
          setSyncStatus("");
        }
      });
    } catch (e) {
      setSyncStatus("");
    }
  }

  async function maybeDoInitialSyncOnce() {
    if (!extensionAlive()) return;
    const data = await storageGet(["INITIAL_SYNC_DONE"]);
    const already = !!data.INITIAL_SYNC_DONE;
    if (already) return;

    await storageSet({ INITIAL_SYNC_DONE: true });
    triggerMarstoySyncWithUI();
  }

  function bindSearchUIListenersOnce() {
    inputElRef = document.getElementById("mt-marstoy-input");
    searchBtnRef = document.getElementById("mt-search-btn");
    resultBoxRef = document.getElementById("mt-marstoy-results");
    themeSelectRef = document.getElementById("mt-theme-select");
    yearSelectRef = document.getElementById("mt-year-select");
    const resetThemeBtn = document.getElementById("mt-reset-theme");
    const resetYearBtn = document.getElementById("mt-reset-year");
    syncBtnRef = document.getElementById("mt-sync-btn");
    syncStatusBoxRef = document.getElementById("mt-sync-status-box");

    if (!inputElRef || !resultBoxRef || !themeSelectRef || !yearSelectRef || !syncBtnRef) return;

    inputElRef.addEventListener("input", renderNow);
    inputElRef.addEventListener("focus", renderNow);
    inputElRef.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        handleEnterRedirect();
      }
    });

    if (searchBtnRef) {
      searchBtnRef.addEventListener("click", () => {
        handleEnterRedirect();
      });
    }

    themeSelectRef.addEventListener("change", () => {
      marstoyCacheFilters.theme = themeSelectRef.value || "";
      renderNow();
    });

    yearSelectRef.addEventListener("change", () => {
      marstoyCacheFilters.year = yearSelectRef.value || "";
      renderNow();
    });

    if (resetThemeBtn) {
      resetThemeBtn.addEventListener("click", () => {
        marstoyCacheFilters.theme = "";
        themeSelectRef.value = "";
        renderNow();
      });
    }

    if (resetYearBtn) {
      resetYearBtn.addEventListener("click", () => {
        marstoyCacheFilters.year = "";
        yearSelectRef.value = "";
        renderNow();
      });
    }

    // manual sync button
    syncBtnRef.addEventListener("click", () => {
      triggerMarstoySyncWithUI();
    });

    // close results when clicking outside
    document.addEventListener("click", (ev) => {
      const box = document.getElementById("mt-marstoy-box");
      if (!box) return;
      if (!box.contains(ev.target)) {
        resultBoxRef.style.display = "none";
      }
    });
  }

  async function marstoySearchInit() {
    if (!searchUIInitialized) {
      createSearchUIIfNeeded();
      await marstoySearchLoadIndexNow();
      populateDropdowns();
      bindSearchUIListenersOnce();
      renderNow();
      searchUIInitialized = true;

      // after UI ready, do first-time auto-sync if needed
      await maybeDoInitialSyncOnce();
      return;
    }

    await marstoySearchLoadIndexNow();
    populateDropdowns();
    renderNow();
  }

  // === Show/hide ME Search panel ===
  function setMeSearchVisible(shouldShow) {
    const wrap = document.getElementById("mt-marstoy-wrapper");
    if (shouldShow) {
      if (!wrap) {
        marstoySearchInit();
      } else {
        wrap.style.display = "block";
      }
    } else {
      if (wrap) {
        wrap.style.display = "none";
      }
    }
  }

  async function initMaybeShowSearch() {
    if (!extensionAlive()) return;
    chrome.storage.local.get(["SHOW_ME_SEARCH"], (res) => {
      const hasKey = Object.prototype.hasOwnProperty.call(res, "SHOW_ME_SEARCH");
      const show = hasKey ? !!res.SHOW_ME_SEARCH : true; // default ON
      if (show) {
        marstoySearchInit();
      }
    });
  }

  // -------------------------------------------------
  // Sync status listener from background
  // -------------------------------------------------
  if (extensionAlive()) {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || !msg.type) return;

        if (msg.type === "TOGGLE_ME_SEARCH_VISIBILITY") {
          setMeSearchVisible(!!msg.enabled);
          sendResponse?.({ ok: true });
          return;
        }

        if (msg.type === "CATALOG_STATUS") {
          // Only update UI if it's shortly after sync request
          const recentClick = (Date.now() - lastSyncClickAt) < 60000;
          if (!recentClick) return;

          if (msg.error) {
            clearCountdownInterval();
            if (syncTimeoutHandle) clearTimeout(syncTimeoutHandle);
            setSyncStatus("");
            return;
          }

          setSyncStatus("done");
        }
      });
    } catch (e) {
      logDebug("runtime.onMessage listener failed in content", e);
    }
  }

  // -------------------------------------------------
  // Image helpers, gallery, title rewriting
  // -------------------------------------------------

  function attachImageFallback(img, data) {
    if (!img || !data) return;
    if (img.__mtHasFallbackLogic) return;
    img.__mtHasFallbackLogic = true;

    const officialId = (data.officialId || '').trim();
    const primaryUrl = data.imageUrl || '';
    const bricklinkUrl = officialId
      ? `https://img.bricklink.com/ItemImage/SN/0/${officialId}-1.png`
      : '';

    if (!primaryUrl && !bricklinkUrl) return;

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

    function setImgSrc(url) {
      if (!url) return;
      nukeSrcset(img);
      img.src = url;
    }

    function isLoadedOk(el) {
      return el.complete && el.naturalWidth > 0;
    }

    let switchedToFallback = false;
    let tForcePrimary2s = null;
    let tSwitchFallback3s = null;
    let tFinal8s = null;
    let finished = false;

    function clearAll() {
      if (tForcePrimary2s) clearTimeout(tForcePrimary2s);
      if (tSwitchFallback3s) clearTimeout(tSwitchFallback3s);
      if (tFinal8s) clearTimeout(tFinal8s);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      finished = true;
    }

    function onLoad() {
      if (isLoadedOk(img)) {
        clearAll();
      }
    }

    function onError() {
      // handled in timed steps
    }

    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);

    // t=0 try primary
    if (primaryUrl && img.src !== primaryUrl) {
      setImgSrc(primaryUrl);
    }

    // t=2s retry primary
    tForcePrimary2s = setTimeout(() => {
      if (finished || isLoadedOk(img)) return;
      if (!switchedToFallback && primaryUrl) {
        setImgSrc(primaryUrl);
      }
    }, 2000);

    // t=3s fallback to BrickLink
    tSwitchFallback3s = setTimeout(() => {
      if (finished || isLoadedOk(img)) return;
      if (bricklinkUrl && !switchedToFallback) {
        switchedToFallback = true;
        setImgSrc(bricklinkUrl);
      }
    }, 3000);

    // t=8s bust cache
    tFinal8s = setTimeout(() => {
      if (finished || isLoadedOk(img)) return;
      const current = img.src || (switchedToFallback ? bricklinkUrl : primaryUrl);
      if (current) {
        setImgSrc(bust(current));
      }
      setTimeout(() => {
        clearAll();
      }, 2000);
    }, 8000);
  }

  function applyContainCenterFit(img) {
    if (!img) return;
    const wrapper =
      img.parentElement ||
      img.closest('.card__media, .product-card__image, .media, .product__media') ||
      img;

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

  function removeZoomClasses(node) {
    const zoomClasses = [
      'card--media-hover','media--hover','hover-zoom','image-hover','hover-effect',
      'zoom','zoom-image','zoom-on-hover','media--cropped',
      'media--square','media--landscape','media--portrait'
    ];
    zoomClasses.forEach(c => node.classList?.remove(c));
  }

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

  function setCardImage(card, data) {
    if (!card) return;

    removeZoomClasses(card);

    const wrappers = [
      card,
      card.querySelector('.card__media'),
      card.querySelector('.product-card__image'),
      card.querySelector('.media'),
      card.querySelector('.media--cropped')
    ].filter(Boolean);

    wrappers.forEach(w => {
      w.style.overflow = 'hidden';
      w.style.transform = 'none';
    });

    const imgs = Array.from(card.querySelectorAll('img'));
    const sources = Array.from(card.querySelectorAll('picture source'));
    const bgEls = Array.from(
      card.querySelectorAll('[style*="background-image"], .media, .product-card__image, .card__media')
    );

    sources.forEach(src => {
      src.srcset = '';
      src.removeAttribute('sizes');
      src.style.display = 'none';
    });
    bgEls.forEach(el => {
      el.style.backgroundImage = 'none';
      el.style.transform = 'none';
    });

    const firstImg = imgs[0];
    if (firstImg) {
      attachImageFallback(firstImg, data);

      if (data.name) firstImg.alt = data.name;
      applyContainCenterFit(firstImg);
    }

    imgs.slice(1).forEach(img => {
      img.style.display = 'none';
      img.style.transform = 'none';
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
    });
  }

  function setCartImage(container, data) {
    if (!container) return;
    const img = container.querySelector('img');
    if (!img) return;

    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('data-sizes');

    attachImageFallback(img, data);

    if (data.name) img.alt = data.name;

    img.style.objectFit = 'contain';
    img.style.objectPosition = 'center center';
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.maxHeight = '160px';
    img.style.transform = 'none';
    img.style.transition = 'none';
  }

  function setGalleryImages(bundle, data) {
    if (!bundle) return;
    const { card, imgs, sources, bgEls } = bundle;

    applyNoFlickerCSSForGallery(card);
    removeZoomClasses(card);
    card.style.transform = 'none';
    card.style.transition = 'none';

    sources.forEach(source => {
      source.srcset = '';
      source.removeAttribute('sizes');
      source.style.display = 'none';
    });
    bgEls.forEach(el => {
      el.style.backgroundImage = 'none';
      el.style.transform = 'none';
    });

    imgs.forEach((img, i) => {
      img.style.opacity = '1';
      img.style.zIndex = i === 0 ? '1' : '0';

      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.removeAttribute('data-sizes');

      attachImageFallback(img, data);

      if (data.name) img.alt = data.name;

      applyContainCenterFit(img);
      img.style.transform = 'translate(-50%, -50%)';
      img.style.transition = 'none';
    });

    card.onmouseenter = () => { card.style.transform = 'none'; };
    card.onmouseleave = () => { card.style.transform = 'none'; };
  }

  // -------------------------------------------------
  // Title formatting
  // -------------------------------------------------

  function formatTitle(data, originalId) {
    const rawId = (originalId || '').toUpperCase();
    const officialId = (data.officialId || '').trim();
    const name = (data.name || '').trim();
    const yearPart = data.year ? ` (${data.year})` : '';

    const left =
      officialId && name
        ? `${officialId} - ${name}`
        : (officialId || name);

    const right = rawId ? ` - ${rawId}` : '';

    return `${left}${yearPart}${right}`.trim();
  }

  function applyTitleToListingCard(card, finalText) {
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
        if (
          /M\d+|N\d+|PARTS KIT|MOC/.test(txt) ||
          sel.includes('unstyled-link') ||
          sel.includes('card__heading')
        ) {
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
        if (
          /M\d+|N\d+|PARTS KIT|MOC/.test(txt) ||
          sel.includes('cart-item__name') ||
          sel.includes('product-title')
        ) {
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

  // -------------------------------------------------
  // Page scanning
  // -------------------------------------------------

  function findListingCards(root = document) {
    const links = Array.from(root.querySelectorAll('a[href*="/products/"]'));
    const seen = new Set();
    const cards = [];

    links.forEach(a => {
      const id =
        extractAnyIdFromHref(a.getAttribute('href') || a.href || '') ||
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

  function findCartLines() {
    const container =
      document.querySelector('form[action="/cart"], #Cart, .cart, .cart__items, .cart-items, .cart__content') ||
      document;

    const lines = Array.from(
      container.querySelectorAll('.cart__row, .cart__item, .cart-item, .cart-items .cart-item, tr.cart__row')
    );

    const out = [];
    lines.forEach(line => {
      const a = line.querySelector('a[href*="/products/"]');
      if (!a) return;
      const id =
        extractAnyIdFromHref(a.getAttribute('href') || a.href || '') ||
        extractAnyIdFromText(line.textContent || '');
      if (!id) return;
      out.push({ id, line });
    });
    return out;
  }

  function getProductGalleryBundle() {
    const main = document.querySelector('main') || document.body;
    const scope =
      main.querySelector(
        '[data-product-single-media-wrapper], [data-product-media-gallery], .product__media, .product-media, .product-gallery, .product__gallery, .product__media-list, .media-gallery, .product-gallery__media, .product__slides'
      ) || main;

    const imgs = Array.from(scope.querySelectorAll('img'));
    const sources = Array.from(scope.querySelectorAll('picture source'));
    const bgEls = Array.from(
      scope.querySelectorAll('[style*="background-image"], .media, .product__media, .product-gallery__media')
    );

    return { card: scope, imgs, sources, bgEls };
  }

  function isProductPage() {
    return (
      !!document.querySelector('meta[property="og:type"][content="product"]') ||
      location.pathname.includes('/products/')
    );
  }

  function isCartPage() {
    return location.pathname === '/cart';
  }

  function getPrimaryProductScope() {
    const main = document.querySelector('main') || document.body;
    return main;
  }

  // -------------------------------------------------
  // Decorators
  // -------------------------------------------------

  async function decorateListingPage(root = document) {
    const cards = findListingCards(root);
    await Promise.all(
      cards.map(async ({ id, card }) => {
        const data = await lookupFromCatalog(id);
        if (!data) return;

        const finalText = formatTitle(data, id);
        applyTitleToListingCard(card, finalText);

        setCardImage(card, data);
      })
    );
  }

  async function decorateCartPage() {
    const lines = findCartLines();
    await Promise.all(
      lines.map(async ({ id, line }) => {
        const data = await lookupFromCatalog(id);
        if (!data) return;

        const finalText = formatTitle(data, id);
        applyTitleToCartLine(line, finalText);

        const imgWrap =
          line.querySelector(
            '.cart-item__image, .cart__image, .cart__media, .media, .cart-item__media, .cart__image-wrapper'
          ) || line;
        setCartImage(imgWrap, data);
      })
    );
  }

  async function decorateProductPage() {
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
          if (id) {
            productId = id;
            lockedProductId = id;
            break;
          }
        }
      }
    }
    if (!productId) return;

    const data = await lookupFromCatalog(productId);
    if (data) {
      const finalText = formatTitle(data, productId);

      const h1 = scope.querySelector('h1.product__title, h1.product-title, h1');
      if (h1) h1.textContent = finalText;

      const galleryBundle = getProductGalleryBundle();
      setGalleryImages(galleryBundle, data);
    }

    const recRoots = Array.from(
      document.querySelectorAll(
        '.related, .recommendations, [data-section-type*="recommendations"], .product-recommendations, .recently-viewed, [data-section-type*="recent"]'
      )
    );
    for (const r of recRoots) {
      await decorateListingPage(r);
    }
  }

  async function decoratePage() {
    if (!ranOnce) {
      ranOnce = true;
    }

    await decorateListingPage(document);

    if (isCartPage()) {
      await decorateCartPage();
    }

    if (isProductPage()) {
      await decorateProductPage();
    }
  }

  // -------------------------------------------------
  // Wiring / lifecycle
  // -------------------------------------------------

  if (extensionAlive()) {
    try {
      chrome.runtime?.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.type === "TOGGLE_ME_SEARCH_VISIBILITY") {
          setMeSearchVisible(!!request.enabled);
          sendResponse?.({ ok: true });
          return;
        }

        if (request?.action === 'convert') {
          decoratePage();
          initMaybeShowSearch();
          sendResponse?.({ status: 'Update complete!' });
        }
      });
    } catch (e) {
      logDebug('onMessage addListener threw', e);
    }
  }

  const observer = new MutationObserver((mutList) => {
    for (const m of mutList) {
      if (m.addedNodes && m.addedNodes.length > 0) {
        clearTimeout(observer._t);
        observer._t = setTimeout(() => {
          decoratePage();
          // no re-init to avoid flicker
        }, 150);
        break;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // fire a sync request (shared by manual click + auto first-run)
  function triggerMarstoySyncWithUI() {
    if (!extensionAlive()) return;

    lastSyncClickAt = Date.now();
    setSyncStatus("loading"); // starts countdown
    armSyncSafetyTimeout();   // fallback after 20s

    try {
      chrome.runtime.sendMessage({ type: "SYNC_COLLECTION" }, () => {
        if (safeHasRuntime() && chrome.runtime.lastError) {
          // immediate fail
          setSyncStatus("");
        }
      });
    } catch (e) {
      setSyncStatus("");
    }
  }

  async function maybeDoInitialSyncOnce() {
    if (!extensionAlive()) return;
    const data = await storageGet(["INITIAL_SYNC_DONE"]);
    const already = !!data.INITIAL_SYNC_DONE;
    if (already) return;

    await storageSet({ INITIAL_SYNC_DONE: true });
    triggerMarstoySyncWithUI();
  }

  function bindSearchUIListenersOnce() {
    inputElRef = document.getElementById("mt-marstoy-input");
    searchBtnRef = document.getElementById("mt-search-btn");
    resultBoxRef = document.getElementById("mt-marstoy-results");
    themeSelectRef = document.getElementById("mt-theme-select");
    yearSelectRef = document.getElementById("mt-year-select");
    const resetThemeBtn = document.getElementById("mt-reset-theme");
    const resetYearBtn = document.getElementById("mt-reset-year");
    syncBtnRef = document.getElementById("mt-sync-btn");
    syncStatusBoxRef = document.getElementById("mt-sync-status-box");

    if (!inputElRef || !resultBoxRef || !themeSelectRef || !yearSelectRef || !syncBtnRef) return;

    inputElRef.addEventListener("input", renderNow);
    inputElRef.addEventListener("focus", renderNow);
    inputElRef.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        handleEnterRedirect();
      }
    });

    if (searchBtnRef) {
      searchBtnRef.addEventListener("click", () => {
        handleEnterRedirect();
      });
    }

    themeSelectRef.addEventListener("change", () => {
      marstoyCacheFilters.theme = themeSelectRef.value || "";
      renderNow();
    });

    yearSelectRef.addEventListener("change", () => {
      marstoyCacheFilters.year = yearSelectRef.value || "";
      renderNow();
    });

    if (resetThemeBtn) {
      resetThemeBtn.addEventListener("click", () => {
        marstoyCacheFilters.theme = "";
        themeSelectRef.value = "";
        renderNow();
      });
    }

    if (resetYearBtn) {
      resetYearBtn.addEventListener("click", () => {
        marstoyCacheFilters.year = "";
        yearSelectRef.value = "";
        renderNow();
      });
    }

    // manual sync button
    syncBtnRef.addEventListener("click", () => {
      triggerMarstoySyncWithUI();
    });

    // close results when clicking outside
    document.addEventListener("click", (ev) => {
      const box = document.getElementById("mt-marstoy-box");
      if (!box) return;
      if (!box.contains(ev.target)) {
        resultBoxRef.style.display = "none";
      }
    });
  }

  async function marstoySearchInit() {
    if (!searchUIInitialized) {
      createSearchUIIfNeeded();
      await marstoySearchLoadIndexNow();
      populateDropdowns();
      bindSearchUIListenersOnce();
      renderNow();
      searchUIInitialized = true;

      // after UI ready, do first-time auto-sync if needed
      await maybeDoInitialSyncOnce();
      return;
    }

    await marstoySearchLoadIndexNow();
    populateDropdowns();
    renderNow();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      decoratePage();
      initMaybeShowSearch();
    }, { once: true });
  } else {
    decoratePage();
    initMaybeShowSearch();
  }

  // === Show/hide ME Search panel ===
  function setMeSearchVisible(shouldShow) {
    const wrap = document.getElementById("mt-marstoy-wrapper");
    if (shouldShow) {
      if (!wrap) {
        marstoySearchInit();
      } else {
        wrap.style.display = "block";
      }
    } else {
      if (wrap) {
        wrap.style.display = "none";
      }
    }
  }

  async function initMaybeShowSearch() {
    if (!extensionAlive()) return;
    chrome.storage.local.get(["SHOW_ME_SEARCH"], (res) => {
      const hasKey = Object.prototype.hasOwnProperty.call(res, "SHOW_ME_SEARCH");
      const show = hasKey ? !!res.SHOW_ME_SEARCH : true; // default ON
      if (show) {
        marstoySearchInit();
      }
    });
  }
})();
