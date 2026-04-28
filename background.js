chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (items) => {
    if (!items.ao3ReaderSettings) {
      chrome.storage.sync.set({
        ao3ReaderSettings: {
          swapLR: false,
          fontSize: 18,
          theme: 'sepia',
          lineHeight: 1.8
        }
      });
    }
  });
});
