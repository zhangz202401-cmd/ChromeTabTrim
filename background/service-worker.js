const DEFAULTS = {
  sleepThresholdMinutes: 60,
  sleepEnabled: true,
  autoDedupEnabled: false,
  autoDedupIntervalMinutes: 30
};
const MAX_HISTORY = 100;
const MULTI_PART_SUFFIXES = new Set([
  'ac.uk', 'co.in', 'co.jp', 'co.kr', 'co.nz', 'co.uk', 'com.au', 'com.cn', 'com.hk', 'com.sg', 'com.tw',
  'edu.cn', 'firm.in', 'gen.in', 'go.jp', 'go.kr', 'gov.cn', 'gov.uk', 'ltd.uk', 'me.uk', 'mil.cn',
  'ne.jp', 'net.au', 'net.cn', 'net.nz', 'or.jp', 'or.kr', 'org.au', 'org.cn', 'org.nz', 'org.uk',
  'plc.uk', 'sch.uk'
]);

function getRootDomain(hostname) {
  if (!hostname || hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

function withDefaultSettings(settings = {}) {
  return { ...DEFAULTS, ...settings };
}

async function syncAlarms(settingsInput) {
  const settings = withDefaultSettings(settingsInput);
  chrome.alarms.create('sleepCheck', { periodInMinutes: 1 });
  await chrome.alarms.clear('dedupeCheck');
  if (settings.autoDedupEnabled) {
    chrome.alarms.create('dedupeCheck', { periodInMinutes: settings.autoDedupIntervalMinutes || DEFAULTS.autoDedupIntervalMinutes });
  }
}

async function ensureAlarmAndStorage() {
  const storage = await chrome.storage.local.get(['settings', 'tabActivity', 'closedHistory']);
  const settings = storage.settings;
  const mergedSettings = withDefaultSettings(settings);
  if (!settings || JSON.stringify(settings) !== JSON.stringify(mergedSettings)) {
    await chrome.storage.local.set({
      settings: mergedSettings,
      tabActivity: storage.tabActivity || {},
      closedHistory: storage.closedHistory || []
    });
  }
  await syncAlarms(mergedSettings);
}

async function syncOpenTabsMetadata() {
  const tabs = await chrome.tabs.query({});
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  const now = Date.now();
  let changed = false;

  for (const tab of tabs) {
    if (!tab?.id) continue;
    const current = tabActivity[tab.id] || {};
    const inferredFirstSeenAt = current.firstSeenAt || tab.lastAccessed || now;
    const inferredLastActiveAt = Math.max(current.lastActiveAt || 0, tab.lastAccessed || 0) || inferredFirstSeenAt;
    const next = {
      ...current,
      url: tab.url ?? current.url ?? '',
      title: tab.title ?? current.title ?? '',
      firstSeenAt: inferredFirstSeenAt,
      lastActiveAt: inferredLastActiveAt
    };

    if (
      !current.firstSeenAt ||
      current.url !== next.url ||
      current.title !== next.title ||
      current.lastActiveAt !== next.lastActiveAt
    ) {
      tabActivity[tab.id] = next;
      changed = true;
    }
  }

  const openIds = new Set(tabs.map(tab => String(tab.id)));
  for (const tabId of Object.keys(tabActivity)) {
    if (!openIds.has(tabId)) {
      delete tabActivity[tabId];
      changed = true;
    }
  }

  if (changed) await chrome.storage.local.set({ tabActivity });
  return tabActivity;
}

async function upsertTabActivity(tabId, tab, updates = {}) {
  if (!tabId) return;
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  const current = tabActivity[tabId] || {};
  const inferredFirstSeenAt = current.firstSeenAt || updates.firstSeenAt || tab?.lastAccessed || Date.now();
  const inferredLastActiveAt = Math.max(current.lastActiveAt || 0, updates.lastActiveAt || 0, tab?.lastAccessed || 0) || inferredFirstSeenAt;
  tabActivity[tabId] = {
    ...current,
    url: tab?.url ?? current.url ?? '',
    title: tab?.title ?? current.title ?? '',
    firstSeenAt: inferredFirstSeenAt,
    lastActiveAt: inferredLastActiveAt
  };
  await chrome.storage.local.set({ tabActivity });
}

async function getDuplicates() {
  const tabs = await chrome.tabs.query({});
  const urlMap = {};
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://')) continue;
    if (!urlMap[tab.url]) urlMap[tab.url] = [];
    urlMap[tab.url].push(tab);
  }
  return Object.values(urlMap).filter(group => group.length > 1);
}

function sortTabsForKeeping(tabs, tabActivity) {
  return [...tabs].sort((a, b) =>
    Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    (tabActivity[b.id]?.lastActiveAt || 0) - (tabActivity[a.id]?.lastActiveAt || 0) ||
    a.index - b.index
  );
}

async function closeExactDuplicateTabs() {
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  const groups = await getDuplicates();
  const toClose = [];

  for (const group of groups) {
    const sorted = sortTabsForKeeping(group, tabActivity);
    toClose.push(...sorted.slice(1).map(tab => tab.id));
  }

  if (toClose.length) await chrome.tabs.remove(toClose);
  return toClose.length;
}

async function getDomainDuplicates() {
  const tabs = await chrome.tabs.query({});
  const domainMap = {};

  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://')) continue;
    try {
      const rootDomain = getRootDomain(new URL(tab.url).hostname);
      if (!domainMap[rootDomain]) domainMap[rootDomain] = [];
      domainMap[rootDomain].push(tab);
    } catch {}
  }

  return Object.entries(domainMap)
    .filter(([, groupTabs]) => groupTabs.length > 1)
    .map(([domain, groupTabs]) => ({ domain, tabs: groupTabs }));
}

async function injectMemoryScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/memory.js']
    });
  } catch {}
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarmAndStorage();
  await syncOpenTabsMetadata();
  // 主动注入到所有已打开的标签页
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) injectMemoryScript(tab.id);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarmAndStorage();
  await syncOpenTabsMetadata();
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) injectMemoryScript(tab.id);
});

chrome.alarms.onAlarm.addListener(async alarm => {
  const { settings, tabActivity } = await chrome.storage.local.get(['settings', 'tabActivity']);
  const mergedSettings = withDefaultSettings(settings);

  if (alarm.name === 'sleepCheck') {
    if (!mergedSettings.sleepEnabled) return;

    const now = Date.now();
    const threshold = (mergedSettings.sleepThresholdMinutes || 60) * 60 * 1000;
    const tabs = await chrome.tabs.query({});

    let staleCount = 0;
    for (const tab of tabs) {
      if (tab.active || tab.discarded || tab.pinned) continue;
      const activity = tabActivity?.[tab.id];
      const lastActive = activity?.lastActiveAt || tab.lastAccessed || 0;
      if (now - lastActive > threshold) {
        staleCount++;
        chrome.tabs.discard(tab.id);
      }
    }

    return;
  }

  if (alarm.name === 'dedupeCheck' && mergedSettings.autoDedupEnabled) {
    await closeExactDuplicateTabs();
  }
});

chrome.tabs.onCreated.addListener(async tab => {
  await upsertTabActivity(tab.id, tab, { firstSeenAt: tab.lastAccessed || Date.now(), lastActiveAt: tab.active ? Date.now() : (tab.lastAccessed || Date.now()) });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await upsertTabActivity(tabId, tab, { lastActiveAt: Date.now() });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && !changeInfo.title && !changeInfo.url) return;
  await upsertTabActivity(tabId, tab, { lastActiveAt: tab.active ? Date.now() : (tab.lastAccessed || 0) });
});

chrome.tabs.onRemoved.addListener(async (tabId, { isWindowClosing }) => {
  if (isWindowClosing) return;
  const { tabActivity = {}, closedHistory = [] } = await chrome.storage.local.get(['tabActivity', 'closedHistory']);
  const activity = tabActivity[tabId];
  if (activity?.url && !activity.url.startsWith('chrome://')) {
    closedHistory.unshift({
      url: activity.url,
      title: activity.title || '',
      closedAt: Date.now(),
      favicon: `https://www.google.com/s2/favicons?domain=${new URL(activity.url).hostname}`
    });
    if (closedHistory.length > MAX_HISTORY) closedHistory.pop();
  }
  delete tabActivity[tabId];
  await chrome.storage.local.set({ closedHistory, tabActivity });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content script 上报内存数据，fire-and-forget，不需要响应
  if (msg.type === 'TAB_MEMORY' && sender.tab?.id) {
    const tabId = sender.tab.id;
    chrome.storage.local.get('tabMemory', ({ tabMemory = {} }) => {
      tabMemory[tabId] = { usedJSHeapSize: msg.usedJSHeapSize, totalJSHeapSize: msg.totalJSHeapSize, ts: Date.now() };
      chrome.storage.local.set({ tabMemory });
    });
    return false; // 明确告知不需要异步响应
  }

  (async () => {
    if (msg.type === 'GET_STATS') {
      const tabs = await chrome.tabs.query({});
      const duplicateGroups = await getDuplicates();
      const duplicateCount = duplicateGroups.reduce((count, group) => count + group.length - 1, 0);
      const sleepCount = tabs.filter(tab => tab.discarded).length;
      const { closedHistory = [] } = await chrome.storage.local.get('closedHistory');
      sendResponse({ total: tabs.length, duplicateCount, sleepCount, recentHistory: closedHistory.slice(0, 5) });
      return;
    }

    if (msg.type === 'CLOSE_DUPLICATES' || msg.type === 'CLOSE_DOMAIN_DUPS') {
      const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
      const groups = msg.type === 'CLOSE_DOMAIN_DUPS'
        ? await getDomainDuplicates()
        : (await getDuplicates()).map(group => ({ domain: '', tabs: group }));
      const selectedDomains = new Set(Array.isArray(msg.domains) ? msg.domains : []);
      const selectedUrls = new Set(Array.isArray(msg.urls) ? msg.urls : []);
      const toClose = [];

      for (const group of groups) {
        if (msg.type === 'CLOSE_DOMAIN_DUPS' && selectedDomains.size && !selectedDomains.has(group.domain)) continue;
        if (msg.type === 'CLOSE_DUPLICATES' && selectedUrls.size && !selectedUrls.has(group.tabs[0]?.url)) continue;
        const sorted = sortTabsForKeeping(group.tabs, tabActivity);
        toClose.push(...sorted.slice(1).map(tab => tab.id));
      }

      if (toClose.length) await chrome.tabs.remove(toClose);
      sendResponse({ closed: toClose.length });
      return;
    }

    if (msg.type === 'GET_DOMAIN_DUPLICATES') {
      const tabActivity = await syncOpenTabsMetadata();
      const groups = await getDomainDuplicates();
      sendResponse(groups
        .map(group => ({
          domain: group.domain,
          count: group.tabs.length,
          tabs: group.tabs
            .map(tab => ({
              id: tab.id,
              title: tab.title,
              url: tab.url,
              windowId: tab.windowId,
              active: tab.active,
              pinned: tab.pinned,
              discarded: tab.discarded,
              firstSeenAt: tabActivity[tab.id]?.firstSeenAt || Date.now(),
              lastActiveAt: tabActivity[tab.id]?.lastActiveAt || 0
            }))
            .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
        }))
        .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)));
      return;
    }

    if (msg.type === 'GET_URL_DUPLICATES') {
      const tabActivity = await syncOpenTabsMetadata();
      const groups = await getDuplicates();
      sendResponse(groups
        .map(group => ({
          url: group[0].url,
          count: group.length,
          tabs: group
            .map(tab => ({
              id: tab.id,
              title: tab.title,
              url: tab.url,
              windowId: tab.windowId,
              active: tab.active,
              pinned: tab.pinned,
              discarded: tab.discarded,
              firstSeenAt: tabActivity[tab.id]?.firstSeenAt || Date.now(),
              lastActiveAt: tabActivity[tab.id]?.lastActiveAt || 0
            }))
            .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
        }))
        .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)));
      return;
    }

    if (msg.type === 'RESTORE_TAB') {
      await chrome.tabs.create({ url: msg.url });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'GET_ALL_TABS') {
      const tabActivity = await syncOpenTabsMetadata();
      const tabs = await chrome.tabs.query({});
      const { tabMemory = {} } = await chrome.storage.local.get('tabMemory');
      sendResponse(tabs.map(tab => ({
        ...tab,
        lastActiveAt: tabActivity[tab.id]?.lastActiveAt || 0,
        firstSeenAt: tabActivity[tab.id]?.firstSeenAt || Date.now(),
        memory: tabMemory[tab.id]?.usedJSHeapSize || 0
      })));
      return;
    }

    if (msg.type === 'GET_HISTORY') {
      const { closedHistory = [] } = await chrome.storage.local.get('closedHistory');
      sendResponse(closedHistory);
      return;
    }

    if (msg.type === 'GET_SETTINGS') {
      const { settings = DEFAULTS } = await chrome.storage.local.get('settings');
      sendResponse(withDefaultSettings(settings));
      return;
    }

    if (msg.type === 'SAVE_SETTINGS') {
      const nextSettings = withDefaultSettings(msg.settings);
      await chrome.storage.local.set({ settings: nextSettings });
      await syncAlarms(nextSettings);
      sendResponse({ ok: true });
    }
  })();
  return true;
});
