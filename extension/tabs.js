/**
 * Tab Manager
 * Manages agent-controlled tabs using Chrome tab groups.
 * All agent tabs are placed in a purple "Agent" group for visual clarity.
 */

const MAX_AGENT_TABS = 5;

let agentGroupId = null;
let agentTabIds = new Set();
let activeAgentTabId = null;
let originalTabId = null; // The tab the user was on when the agent started

/**
 * Initialize the tab manager. Call when the agent session starts.
 * Adds the current active tab to the agent group.
 */
async function initTabManager() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  originalTabId = tab.id;
  activeAgentTabId = tab.id;
  agentTabIds.clear();
  agentTabIds.add(tab.id);

  // Create a tab group with the current tab
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  agentGroupId = groupId;

  // Style the group
  await chrome.tabGroups.update(groupId, {
    title: "Agent",
    color: "purple",
    collapsed: false,
  });

  return tab.id;
}

/**
 * Clean up: ungroup all agent tabs (don't close them).
 */
async function cleanupTabManager() {
  if (agentGroupId !== null) {
    // Ungroup tabs so the user keeps them without the "Agent" label
    try {
      const tabIdsArray = Array.from(agentTabIds);
      if (tabIdsArray.length > 0) {
        await chrome.tabs.ungroup(tabIdsArray);
      }
    } catch (_) {}
  }

  agentGroupId = null;
  agentTabIds.clear();
  activeAgentTabId = null;
  originalTabId = null;
}

/**
 * Open a new tab and add it to the agent group.
 * Returns { tabId, tabIndex } or null if limit reached.
 */
async function agentNewTab(url) {
  if (agentTabIds.size >= MAX_AGENT_TABS) {
    console.warn(`Agent tab limit (${MAX_AGENT_TABS}) reached`);
    return null;
  }

  const tab = await chrome.tabs.create({
    url: url || "about:blank",
    active: true,
  });

  agentTabIds.add(tab.id);
  activeAgentTabId = tab.id;

  // Add to agent group
  if (agentGroupId !== null) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: agentGroupId });
    } catch (_) {
      // Group might have been removed if all tabs were ungrouped
    }
  }

  // Wait for the tab to load
  if (url && url !== "about:blank") {
    await new Promise((resolve) => {
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout after 10s
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });
  }

  return { tabId: tab.id, index: agentTabIds.size - 1 };
}

/**
 * Switch the agent's focus to a different tab (by tab ID).
 */
async function agentSwitchTab(tabId) {
  if (!agentTabIds.has(tabId)) {
    console.warn(`Tab ${tabId} is not an agent tab`);
    return false;
  }

  await chrome.tabs.update(tabId, { active: true });
  activeAgentTabId = tabId;

  // Reattach debugger to the new tab
  await detachDebugger();
  return true;
}

/**
 * Close an agent tab. Cannot close the original tab.
 */
async function agentCloseTab(tabId) {
  if (tabId === originalTabId) {
    console.warn("Cannot close the original tab");
    return false;
  }

  if (!agentTabIds.has(tabId)) {
    return false;
  }

  agentTabIds.delete(tabId);
  await chrome.tabs.remove(tabId);

  // If we closed the active tab, switch to original
  if (activeAgentTabId === tabId) {
    activeAgentTabId = originalTabId;
    await chrome.tabs.update(originalTabId, { active: true });
    await detachDebugger();
  }

  return true;
}

/**
 * Get a list of all agent tabs with their info.
 * Used to tell the model which tabs are open.
 */
async function getAgentTabs() {
  const tabs = await chrome.tabs.query({});
  const agentTabs = [];

  for (const tab of tabs) {
    if (agentTabIds.has(tab.id)) {
      agentTabs.push({
        tabId: tab.id,
        title: tab.title || "(untitled)",
        url: tab.url || "",
        isActive: tab.id === activeAgentTabId,
      });
    }
  }

  return agentTabs;
}

/**
 * Get the currently active agent tab ID.
 */
function getActiveAgentTabId() {
  return activeAgentTabId;
}
