(function () {
  const statusLabelEl = document.getElementById("statusLabel");
  const lastUpdatedCatalogEl = document.getElementById("lastUpdatedCatalog");
  const lastSyncedCollectionEl = document.getElementById("lastSyncedCollection");
  const refreshBtn = document.getElementById("refreshBtn");
  const syncBtn = document.getElementById("syncBtn");
  const repoLink = document.getElementById("repoLink");
  const toggleMeSearchEl = document.getElementById("toggleMeSearch");

  const GITHUB_URL = "https://github.com/KostraTech/MarstoyEnhancer";

  function setStatus(msg) {
    statusLabelEl.textContent = msg;
  }

  function setLoadingCatalog(isLoading) {
    refreshBtn.disabled = isLoading;
  }

  function setLoadingCollection(isLoading) {
    syncBtn.disabled = isLoading;
  }

  function formatTimestamp(ts) {
    if (!ts) return "never";
    try {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes()
      ).padStart(2, "0")}`;
    } catch {
      return String(ts);
    }
  }

  function loadTimestamps() {
    chrome.storage.local.get(
      ["CATALOG_LAST_UPDATED", "ALL_BRICK_KITS_LAST_SYNC"],
      (res) => {
        lastUpdatedCatalogEl.textContent = formatTimestamp(res.CATALOG_LAST_UPDATED);
        lastSyncedCollectionEl.textContent = formatTimestamp(res.ALL_BRICK_KITS_LAST_SYNC);
      }
    );
  }

  function triggerRefreshCatalog() {
    setLoadingCatalog(true);
    setStatus("Updating Lego catalog…");

    chrome.runtime.sendMessage({ type: "REFRESH_CATALOG" }, () => {
      if (chrome.runtime.lastError) {
        setStatus("Failed to start catalog update.");
        setLoadingCatalog(false);
      }
    });
  }

  function triggerSyncCollection() {
    setLoadingCollection(true);
    setStatus("Syncing Marstoy cache…");

    chrome.runtime.sendMessage({ type: "SYNC_COLLECTION" }, () => {
      if (chrome.runtime.lastError) {
        setStatus("Failed to start cache sync.");
        setLoadingCollection(false);
      }
    });
  }

  function openGitHub(e) {
    e.preventDefault();
    chrome.tabs.create({ url: GITHUB_URL });
  }

  // ====== ME Search toggle (default ON) ======
  function loadMeSearchToggle() {
    chrome.storage.local.get(["SHOW_ME_SEARCH"], (res) => {
      const hasSetting = Object.prototype.hasOwnProperty.call(res, "SHOW_ME_SEARCH");
      const isEnabled = hasSetting ? !!res.SHOW_ME_SEARCH : true; // default ON
      toggleMeSearchEl.checked = isEnabled;

      // if the key doesn't exist, create it as true => first load = enabled
      if (!hasSetting && isEnabled) {
        chrome.storage.local.set({ SHOW_ME_SEARCH: true });
      }
    });
  }

  function saveMeSearchToggle() {
    const enabled = toggleMeSearchEl.checked;
    chrome.storage.local.set({ SHOW_ME_SEARCH: enabled }, () => {
      // notify the active tab to show/hide the ME Search panel immediately
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "TOGGLE_ME_SEARCH_VISIBILITY",
          enabled,
        });
      });
    });
  }

  // Listen for status updates from the background script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "CATALOG_STATUS") {
      if (msg.text) setStatus(msg.text);

      if (msg.done || msg.error) {
        setLoadingCatalog(false);
        setLoadingCollection(false);
        loadTimestamps();
      }
    }
  });

  // Event bindings
  refreshBtn.addEventListener("click", triggerRefreshCatalog);
  syncBtn.addEventListener("click", triggerSyncCollection);
  repoLink.addEventListener("click", openGitHub);
  toggleMeSearchEl.addEventListener("change", saveMeSearchToggle);

  // Initialize popup UI
  setStatus("Idle.");
  loadTimestamps();
  loadMeSearchToggle();
})();
