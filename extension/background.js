// Service worker — opens the side panel when the toolbar action is clicked.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) =>
    console.error("[pixelfoxx] sidePanel.open failed:", e)
  );
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("[pixelfoxx] setPanelBehavior:", e));
});
