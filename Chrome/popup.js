document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('apiKeyInput');
  const btn = document.getElementById('saveKeyBtn');
  const status = document.getElementById('status');
  const toggleBtn = document.getElementById('toggleVisibilityBtn');
  const eyeIcon = document.getElementById('eyeIcon');

  // Load saved key (masked by default)
  chrome.storage.local.get(['REBRICKABLE_API_KEY'], (result) => {
    if (result.REBRICKABLE_API_KEY) {
      input.value = result.REBRICKABLE_API_KEY;
      input.type = 'password'; // keep masked
      eyeIcon.className = 'eye-off';
    }
  });

  // Save key
  btn.addEventListener('click', () => {
    const key = (input.value || '').trim();
    if (!key) {
      status.style.color = '#b3261e';
      status.textContent = 'Please enter a valid key.';
      return;
    }
    chrome.storage.local.set({ REBRICKABLE_API_KEY: key }, () => {
      status.style.color = '#2e7d32';
      status.textContent = '✅ Key saved (stored locally).';
      // No reload required—content script listens for changes.
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  });

  // Toggle visibility (eye icon)
  toggleBtn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    eyeIcon.className = showing ? 'eye-off' : 'eye';
    // Keep focus on input for convenience
    input.focus({ preventScroll: true });
    // Move cursor to end
    const val = input.value;
    input.value = '';
    input.value = val;
  });
});
