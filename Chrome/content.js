(function () {
  const { MESSAGE_TYPES, DOM_SELECTORS, INTERNAL_NODE_IDS } = MarstoyShared;
  const { extensionAlive, logDebug } = MarstoyRuntime;
  const { decoratePage, decorateMutations } = MarstoyTitles;
  const { initMaybeShowSearch, setMeSearchVisible, handleCatalogStatus } = MarstoySearch;

  let decorateTimer = null;
  let pendingMutations = [];
  let initRequested = false;

  const OBSERVER_ROOT_SELECTOR = 'main, body';
  const RELEVANT_MUTATION_SELECTOR = DOM_SELECTORS.listingOrRecommendationMutation;

  function getObserverRoot() {
    return document.querySelector(OBSERVER_ROOT_SELECTOR) || document.documentElement;
  }

  function decorateAndInit() {
    decoratePage();

    if (!initRequested) {
      initRequested = true;
      initMaybeShowSearch();
    }
  }

  function scheduleDecorate(delay = 150, mutations = null) {
    if (Array.isArray(mutations) && mutations.length > 0) {
      pendingMutations.push(...mutations);
    }

    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(async () => {
      const queuedMutations = pendingMutations;
      pendingMutations = [];

      if (queuedMutations.length > 0) {
        await decorateMutations(queuedMutations);
        if (!initRequested) {
          decorateAndInit();
        }
        return;
      }

      decorateAndInit();
    }, delay);
  }

  function isRelevantAddedNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (INTERNAL_NODE_IDS.includes(node.id)) return false;
    if (node.matches?.(RELEVANT_MUTATION_SELECTOR)) return true;
    return !!node.querySelector?.(RELEVANT_MUTATION_SELECTOR);
  }

  function mutationNeedsDecorate(mutation) {
    if (!mutation || mutation.type !== 'childList' || !mutation.addedNodes || mutation.addedNodes.length === 0) {
      return false;
    }

    for (const node of mutation.addedNodes) {
      if (isRelevantAddedNode(node)) return true;
    }
    return false;
  }

  function handleMessage(msg, sendResponse) {
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.toggleMeSearchVisibility) {
      setMeSearchVisible(!!msg.enabled, { resetPosition: !!msg.resetPosition });
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === MESSAGE_TYPES.catalogStatus) {
      handleCatalogStatus(msg);
    }
  }

  if (extensionAlive()) {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        handleMessage(msg, sendResponse);
      });
    } catch (error) {
      logDebug('runtime.onMessage listener failed in content', error);
    }
  }

  const observer = new MutationObserver(mutList => {
    const relevantMutations = [];
    for (const mutation of mutList) {
      if (mutationNeedsDecorate(mutation)) {
        relevantMutations.push(mutation);
      }
    }

    if (relevantMutations.length > 0) {
      scheduleDecorate(150, relevantMutations);
    }
  });
  observer.observe(getObserverRoot(), { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorateAndInit, { once: true });
  } else {
    decorateAndInit();
  }
})();