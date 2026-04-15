(function () {
  const { MESSAGE_TYPES, STORAGE_KEYS, compareVersions, formatTimestamp } = MarstoyShared;
  const { storageGet, storageSet, sendRuntimeMessage, sendTabMessage } = MarstoyRuntime;

  const els = {
    statusLabel: document.getElementById('statusLabel'),
    lastUpdatedCatalog: document.getElementById('lastUpdatedCatalog'),
    lastSyncedCollection: document.getElementById('lastSyncedCollection'),
    refreshBtn: document.getElementById('refreshBtn'),
    syncBtn: document.getElementById('syncBtn'),
    toggleMeSearch: document.getElementById('toggleMeSearch'),
    versionText: document.getElementById('versionText'),
    updateLink: document.getElementById('updateLink'),
  };

  const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/KostraTech/MarstoyEnhancer/releases/latest';
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const CURRENT_VERSION = `v${chrome.runtime.getManifest().version}`;

  function setStatus(msg) {
    els.statusLabel.textContent = msg;
  }

  function setButtonLoading(button, isLoading) {
    button.disabled = isLoading;
  }

  function renderVersionInfo(latestTag = '', hasUpdate = false) {
    els.versionText.textContent = `GitHub · ${CURRENT_VERSION}`;

    if (hasUpdate && latestTag) {
      els.updateLink.textContent = '(Update available)';
      els.updateLink.style.display = 'inline';
      els.updateLink.title = `Latest release: ${latestTag}`;
      return;
    }

    els.updateLink.textContent = '';
    els.updateLink.style.display = 'none';
    els.updateLink.removeAttribute('title');
  }

  async function loadTimestamps() {
    const res = await storageGet([
      STORAGE_KEYS.catalogLastUpdated,
      STORAGE_KEYS.allBrickKitsLastSync,
    ]);

    els.lastUpdatedCatalog.textContent = formatTimestamp(res[STORAGE_KEYS.catalogLastUpdated]);
    els.lastSyncedCollection.textContent = formatTimestamp(res[STORAGE_KEYS.allBrickKitsLastSync]);
  }

  function startJob(button, statusText, messageType, failureText) {
    setButtonLoading(button, true);
    setStatus(statusText);
    sendRuntimeMessage({ type: messageType }, () => {
      setStatus(failureText);
      setButtonLoading(button, false);
    });
  }

  function triggerRefreshCatalog() {
    startJob(
      els.refreshBtn,
      'Updating Lego catalog…',
      MESSAGE_TYPES.refreshCatalog,
      'Failed to start catalog update.'
    );
  }

  function triggerSyncCollection() {
    startJob(
      els.syncBtn,
      'Syncing Marstoy cache…',
      MESSAGE_TYPES.syncCollection,
      'Failed to start cache sync.'
    );
  }

  async function loadMeSearchToggle() {
    const res = await storageGet([STORAGE_KEYS.showMeSearch]);
    const hasSetting = Object.prototype.hasOwnProperty.call(res, STORAGE_KEYS.showMeSearch);
    const isEnabled = hasSetting ? !!res[STORAGE_KEYS.showMeSearch] : true;

    els.toggleMeSearch.checked = isEnabled;

    if (!hasSetting && isEnabled) {
      await storageSet({ [STORAGE_KEYS.showMeSearch]: true });
    }
  }

  function saveMeSearchToggle() {
    const enabled = els.toggleMeSearch.checked;

    storageSet({ [STORAGE_KEYS.showMeSearch]: enabled }).then(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (!tabs || !tabs[0]) return;

        sendTabMessage(tabs[0].id, {
          type: MESSAGE_TYPES.toggleMeSearchVisibility,
          enabled,
          resetPosition: true,
        });
      });
    });
  }

  async function fetchLatestReleaseTag() {
    const resp = await fetch(GITHUB_LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });

    if (!resp.ok) {
      throw new Error(`GitHub API HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return String(data?.tag_name || '').trim();
  }

  async function loadGitHubUpdateState() {
    renderVersionInfo();

    try {
      const cached = (await storageGet([STORAGE_KEYS.updateCheckCache]))[STORAGE_KEYS.updateCheckCache] || null;
      const now = Date.now();

      if (
        cached &&
        cached.currentVersion === CURRENT_VERSION &&
        typeof cached.checkedAt === 'number' &&
        now - cached.checkedAt < ONE_WEEK_MS
      ) {
        renderVersionInfo(cached.latestTag || '', !!cached.hasUpdate);
        return;
      }

      const latestTag = await fetchLatestReleaseTag();
      const hasUpdate = !!latestTag && compareVersions(latestTag, CURRENT_VERSION) > 0;

      await storageSet({
        [STORAGE_KEYS.updateCheckCache]: {
          checkedAt: now,
          currentVersion: CURRENT_VERSION,
          latestTag,
          hasUpdate,
        },
      });

      renderVersionInfo(latestTag, hasUpdate);
    } catch {
      renderVersionInfo();
    }
  }

  function handleStatusMessage(msg) {
    if (msg?.type !== MESSAGE_TYPES.catalogStatus) return;

    if (msg.text) {
      setStatus(msg.text);
    }

    if (msg.done || msg.error) {
      setButtonLoading(els.refreshBtn, false);
      setButtonLoading(els.syncBtn, false);
      loadTimestamps();
    }
  }

  function bindEvents() {
    chrome.runtime.onMessage.addListener(handleStatusMessage);
    els.refreshBtn.addEventListener('click', triggerRefreshCatalog);
    els.syncBtn.addEventListener('click', triggerSyncCollection);
    els.toggleMeSearch.addEventListener('change', saveMeSearchToggle);
  }

  async function init() {
    bindEvents();
    setStatus('Idle.');
    await loadTimestamps();
    await loadMeSearchToggle();
    await loadGitHubUpdateState();
  }

  init();
})();
