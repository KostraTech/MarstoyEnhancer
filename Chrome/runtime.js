(function (global) {
  const { MESSAGE_TYPES, cacheKey, toOfficialId } = global.MarstoyShared;

  const debugMode = false;

  function logDebug(msg, data = null) {
    if (!debugMode) return;
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`, data || '');
  }

  function safeHasRuntime() {
    try {
      return typeof chrome !== 'undefined' && chrome && chrome.runtime;
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
      return !!(
        typeof chrome !== 'undefined' &&
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

  function getLastError() {
    return safeHasRuntime() ? chrome.runtime.lastError : null;
  }

  function storageGet(keys) {
    if (!extensionAlive()) {
      logDebug('storageGet: extension not alive');
      return Promise.resolve({});
    }

    return new Promise(resolve => {
      try {
        chrome.storage.local.get(keys, result => {
          if (getLastError()) {
            logDebug('storage.get lastError:', getLastError());
            resolve({});
            return;
          }

          resolve(result || {});
        });
      } catch (error) {
        logDebug('storage.get threw:', error);
        resolve({});
      }
    });
  }

  function storageSet(values) {
    if (!extensionAlive()) return Promise.resolve();

    return new Promise(resolve => {
      try {
        chrome.storage.local.set(values, () => {
          if (getLastError()) {
            logDebug('storage.set lastError:', getLastError());
          }
          resolve();
        });
      } catch (error) {
        logDebug('storage.set threw:', error);
        resolve();
      }
    });
  }

  function sendRuntimeMessage(message, onImmediateFailure) {
    if (!extensionAlive()) {
      if (typeof onImmediateFailure === 'function') onImmediateFailure();
      return;
    }

    try {
      chrome.runtime.sendMessage(message, () => {
        if (getLastError() && typeof onImmediateFailure === 'function') {
          onImmediateFailure(getLastError());
        }
      });
    } catch (error) {
      logDebug('runtime.sendMessage threw:', error);
      if (typeof onImmediateFailure === 'function') {
        onImmediateFailure(error);
      }
    }
  }

  function sendTabMessage(tabId, message, onImmediateFailure) {
    try {
      chrome.tabs.sendMessage(tabId, message, () => {
        if (getLastError() && typeof onImmediateFailure === 'function') {
          onImmediateFailure(getLastError());
        }
      });
    } catch (error) {
      logDebug('tabs.sendMessage threw:', error);
      if (typeof onImmediateFailure === 'function') {
        onImmediateFailure(error);
      }
    }
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

  function extractAnyIdFromText(text) {
    const match = (text || '').toUpperCase().match(/\b([MN]\d{4,7})\b/);
    return match ? match[1] : null;
  }

  function extractAnyIdFromHref(href = '') {
    const fromProductPath = href.match(/\/products\/.*?([mn]\d{4,7})/i);
    if (fromProductPath) return fromProductPath[1].toUpperCase();

    const fromAnywhere = href.match(/([mn]\d{4,7})/i);
    if (fromAnywhere) return fromAnywhere[1].toUpperCase();

    const numericPath = href.match(/\/products\/(\d{4,7})/i);
    if (numericPath) return `M${numericPath[1]}`.toUpperCase();

    return null;
  }

  function getAllowedProductIdFromCurrentPath() {
    const path = location.pathname || '';
    const match = path.match(/^\/products\/.*?([mn]\d{4,7})(?:[^\d]|$)/i);
    return match ? match[1].toUpperCase() : null;
  }

  async function lookupByOfficialId(officialId, cacheId = '') {
    const normalizedOfficialId = (officialId || '').trim();
    if (!normalizedOfficialId) return null;

    const cacheLookupId = cacheId || normalizedOfficialId;
    const cached = await getCacheItem(cacheLookupId);
    if (cached) return cached;

    if (!extensionAlive()) {
      logDebug('lookupByOfficialId: extension not alive');
      return null;
    }

    const entry = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { type: MESSAGE_TYPES.lookupSet, officialId: normalizedOfficialId },
          response => {
            if (getLastError()) {
              logDebug('LOOKUP_SET lastError', getLastError());
              resolve(null);
              return;
            }

            resolve(response?.entry || null);
          }
        );
      } catch (error) {
        logDebug('LOOKUP_SET threw', error);
        resolve(null);
      }
    });

    if (!entry) return null;
    await setCacheItem(cacheLookupId, entry);
    return entry;
  }

  function lookupFromCatalog(mOrN) {
    const officialId = toOfficialId(mOrN);
    if (!officialId) return Promise.resolve(null);

    return lookupByOfficialId(officialId, mOrN);
  }

  global.MarstoyRuntime = {
    logDebug,
    safeHasRuntime,
    safeHasRuntimeId,
    safeHasStorage,
    extensionAlive,
    getLastError,
    storageGet,
    storageSet,
    sendRuntimeMessage,
    sendTabMessage,
    setCacheItem,
    getCacheItem,
    extractAnyIdFromText,
    extractAnyIdFromHref,
    getAllowedProductIdFromCurrentPath,
    lookupByOfficialId,
    lookupFromCatalog,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
