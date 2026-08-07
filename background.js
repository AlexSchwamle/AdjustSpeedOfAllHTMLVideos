/* Registers the "VSC: Block this element…" context menu item.
   Deliberately uses contexts: ["all"] rather than ["video"] — Chrome's
   "video" context only fires when the actual click target is a <video>
   element, but most custom players (Netflix, YouTube, X, etc.) layer
   their own control divs on top of the real <video> tag, so a right-
   click essentially never lands on the bare element itself. Instead,
   this always shows up, and the content script figures out the right
   target itself: whichever managed video currently has its overlay
   visible when the right-click happens (see the contextmenu listener
   in content.js). If no video was being hovered, the message is just a
   no-op there. */

if (!chrome.contextMenus) {
  /* chrome.contextMenus is only defined when "contextMenus" is present
     in manifest.json's permissions array. Everything below depends on
     it, and an uncaught error at top level here would abort the whole
     service worker's registration (this is what status code 15 during
     registration actually was) — so guard the whole file on it instead
     of letting that happen again. If you're seeing this message, the
     manifest.json actually loaded into chrome://extensions is missing
     "contextMenus" from its permissions list (double check that's the
     exact file in the extension's folder — this is the most common way
     to end up here even after editing the "right" copy). */
  console.error(
    'Video Speed Controller: chrome.contextMenus is unavailable — "contextMenus" is missing from manifest.json permissions. The block-element feature will not work until that\'s fixed and the extension is reloaded.'
  );
} else {
  function registerContextMenu() {
    // removeAll first: re-registering with the same id after the service
    // worker restarts (or during dev reloads) would otherwise fail with a
    // "duplicate id" error that chrome.contextMenus.create() reports only
    // via the callback — easy to miss, and the net effect is just a
    // silently-missing menu item.
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create(
        {
          id: "vsc-block-element",
          title: "VSC: Block this element…",
          contexts: ["all"],
        },
        () => {
          if (chrome.runtime.lastError) {
            console.error("Video Speed Controller: context menu registration failed:", chrome.runtime.lastError.message);
          }
        }
      );
    });
  }

  chrome.runtime.onInstalled.addListener(registerContextMenu);
  // onInstalled only fires on install/update, not on every service worker
  // wake-up — re-registering on startup too means the menu survives the
  // worker being terminated and restarted by Chrome during normal use.
  chrome.runtime.onStartup.addListener(registerContextMenu);

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "vsc-block-element" || tab?.id == null) return;
    chrome.tabs.sendMessage(tab.id, { type: "vsc-block-element" }, () => {
      // No content script in this tab (e.g. a chrome:// page) — nothing to do.
      if (chrome.runtime.lastError) {
        console.warn("Video Speed Controller: couldn't reach content script:", chrome.runtime.lastError.message);
      }
    });
  });
}