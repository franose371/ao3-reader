chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (items) => {
    if (!items.ao3ReaderSettings) {
      chrome.storage.sync.set({
        ao3ReaderSettings: {
          swapLR: false,
          fontSize: 18,
          theme: 'light',
          lineHeight: 1.8,
          marginTop: 12,
          marginBottom: 12,
          marginLeft: 20,
          marginRight: 20
        }
      });
    }
  });
});
