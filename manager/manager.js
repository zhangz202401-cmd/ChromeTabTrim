async function send(type, data = {}, retries = 5) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type, ...data });
      if (res !== undefined) return res;
    } catch (e) {
      if (i === retries) return null;
    }
    await new Promise(r => setTimeout(r, 200 + 200 * i));
  }
  return null;
}

async function waitForServiceWorker() {
  for (let i = 0; i < 10; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      if (res !== undefined) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
}

function memStr(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(ts) {
  if (!ts) return '未知';
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return `${months} 个月前`;
}

function durationText(ts) {
  if (!ts) return '刚开始记录';
  const minutes = Math.max(1, Math.floor((Date.now() - ts) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.floor(days / 30);
  return `${months} 个月`;
}

function favicon(url, favIconUrl) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(parsed.href)}&size=16`;
    }
  } catch {}

  if (typeof favIconUrl === 'string' && (favIconUrl.startsWith('data:') || favIconUrl.startsWith('chrome-extension://'))) {
    return favIconUrl;
  }

  return '';
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(value) {
  return escHtml(value);
}

const panels = { overview: loadOverview, sleep: loadSleep, history: loadHistory, settings: loadSettings };
let selectedIds = new Set();
let selectedDomainGroups = new Set();
let domainGroupsCache = [];
let currentDomainPage = 1;
let selectedUrlGroups = new Set();
let urlGroupsCache = [];
let currentUrlPage = 1;
const DOMAIN_GROUPS_PER_PAGE = 4;

function normalizeQuery(value) {
  return String(value || '').trim().toLowerCase();
}

function getTabSearchText(tab) {
  let host = '';
  try { host = new URL(tab.url || '').hostname; } catch {}
  return [tab.title, tab.url, host].filter(Boolean).join(' ').toLowerCase();
}

function matchesTabQuery(tab, query) {
  return !query || getTabSearchText(tab).includes(query);
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    panels[btn.dataset.tab]?.();
  });
});

function updateCloseSelected() {
  const btn = document.getElementById('closeSelected');
  btn.disabled = selectedIds.size === 0;
  btn.textContent = selectedIds.size ? `关闭选中 (${selectedIds.size})` : '关闭选中';
}

function bindTabSelection(container) {
  container.querySelectorAll('input[type=checkbox][data-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(Number(cb.dataset.id));
      else selectedIds.delete(Number(cb.dataset.id));
      updateCloseSelected();
    });
  });
}

function bindJumpLinks(container) {
  container.querySelectorAll('.jump-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.update(Number(link.dataset.id), { active: true });
      chrome.windows.update(Number(link.dataset.wid), { focused: true });
    });
  });
}

function bindTabCloseActions(container, onDone) {
  container.querySelectorAll('[data-close-tab]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await chrome.tabs.remove(Number(btn.dataset.closeTab));
      onDone?.();
    });
  });
}

function buildTabRow(tab, options = {}) {
  const selectable = options.selectable ? `<input type="checkbox" data-id="${tab.id}">` : '';
  const mem = memStr(tab.memory);
  const meta = [
    `<span class="meta-pill">${tab.discarded ? '休眠中' : '活跃中'}</span>`,
    mem ? `<span class="meta-pill mem">${mem}</span>` : '',
    `<span class="meta-pill">已记录 ${durationText(tab.firstSeenAt)}</span>`,
    `<span class="meta-pill">最近访问 ${timeAgo(tab.lastActiveAt)}</span>`
  ].filter(Boolean);

  if (tab.pinned) meta.unshift('<span class="meta-pill accent">已固定</span>');
  if (tab.active) meta.unshift('<span class="meta-pill accent">当前页</span>');

  return `
    <li class="item-row ${tab.discarded ? 'discarded' : ''}">
      ${selectable}
      <img src="${favicon(tab.url || '', tab.favIconUrl)}" onerror="this.style.display='none'">
      <div class="item-main">
        <div class="item-title-row">
          <a class="jump-link" data-id="${tab.id}" data-wid="${tab.windowId}" title="${escAttr(tab.url)}">${escHtml(tab.title || tab.url || '(无标题)')}</a>
          <button class="ghost-action danger" data-close-tab="${tab.id}">关闭</button>
        </div>
        <div class="item-url">${escHtml(tab.url || '')}</div>
        <div class="item-meta">${meta.join('')}</div>
      </div>
    </li>`;
}

function buildDomainCard(group) {
  const removableCount = Math.max(0, group.tabs.length - 1);
  const rows = group.tabs.map(tab => `
    <li class="domain-tab-row ${tab.discarded ? 'discarded' : ''}">
      <img src="${favicon(tab.url || '', tab.favIconUrl)}" onerror="this.style.display='none'">
      <div class="domain-tab-main">
        <div class="domain-tab-head">
          <a class="jump-link" data-id="${tab.id}" data-wid="${tab.windowId}" title="${escAttr(tab.url)}">${escHtml(tab.title || tab.url || '(无标题)')}</a>
          <button class="ghost-action danger" data-close-tab="${tab.id}">关闭</button>
        </div>
        <div class="domain-tab-url">${escHtml(tab.url || '')}</div>
        <div class="item-meta compact">
          ${tab.active ? '<span class="meta-pill accent">当前页</span>' : ''}
          ${tab.discarded ? '<span class="meta-pill">休眠中</span>' : ''}
          ${tab.pinned ? '<span class="meta-pill accent">已固定</span>' : ''}
          <span class="meta-pill">已记录 ${durationText(tab.firstSeenAt)}</span>
          <span class="meta-pill">最近访问 ${timeAgo(tab.lastActiveAt)}</span>
        </div>
      </div>
    </li>
  `).join('');

  return `
    <article class="domain-card selected" data-domain="${escAttr(group.domain)}">
      <div class="domain-card-head">
        <label class="domain-toggle">
          <input type="checkbox" class="domain-dup-checkbox" data-domain="${escAttr(group.domain)}" checked>
          <span class="domain-name">${escHtml(group.domain)}</span>
        </label>
        <div class="domain-card-stats">
          <span>${group.count} 个标签页</span>
          <span>${removableCount} 个可关闭</span>
        </div>
      </div>
      <ul class="domain-tab-list">
        ${rows}
      </ul>
    </article>`;
}

function buildUrlDuplicateCard(group) {
  const removableCount = Math.max(0, group.tabs.length - 1);
  const rows = group.tabs.map(tab => `
    <li class="domain-tab-row ${tab.discarded ? 'discarded' : ''}">
      <img src="${favicon(tab.url || '', tab.favIconUrl)}" onerror="this.style.display='none'">
      <div class="domain-tab-main">
        <div class="domain-tab-head">
          <a class="jump-link" data-id="${tab.id}" data-wid="${tab.windowId}" title="${escAttr(tab.url)}">${escHtml(tab.title || tab.url || '(无标题)')}</a>
          <button class="ghost-action danger" data-close-tab="${tab.id}">关闭</button>
        </div>
        <div class="domain-tab-url">${escHtml(tab.url || '')}</div>
        <div class="item-meta compact">
          ${tab.active ? '<span class="meta-pill accent">当前页</span>' : ''}
          ${tab.discarded ? '<span class="meta-pill">休眠中</span>' : ''}
          ${tab.pinned ? '<span class="meta-pill accent">已固定</span>' : ''}
          <span class="meta-pill">已记录 ${durationText(tab.firstSeenAt)}</span>
          <span class="meta-pill">最近访问 ${timeAgo(tab.lastActiveAt)}</span>
        </div>
      </div>
    </li>
  `).join('');

  return `
    <article class="domain-card selected" data-url="${escAttr(group.url)}">
      <div class="domain-card-head">
        <label class="domain-toggle">
          <input type="checkbox" class="url-dup-checkbox" data-url="${escAttr(group.url)}" checked>
          <span class="domain-name" title="${escAttr(group.url)}">${escHtml(group.url)}</span>
        </label>
        <div class="domain-card-stats">
          <span>${group.count} 个标签页</span>
          <span>${removableCount} 个可关闭</span>
        </div>
      </div>
      <ul class="domain-tab-list">
        ${rows}
      </ul>
    </article>`;
}

function getDomainPageCount() {
  return Math.max(1, Math.ceil(domainGroupsCache.length / DOMAIN_GROUPS_PER_PAGE));
}

function getDomainPageGroups() {
  const start = (currentDomainPage - 1) * DOMAIN_GROUPS_PER_PAGE;
  return domainGroupsCache.slice(start, start + DOMAIN_GROUPS_PER_PAGE);
}

function getUrlPageCount() {
  return Math.max(1, Math.ceil(urlGroupsCache.length / DOMAIN_GROUPS_PER_PAGE));
}

function getUrlPageGroups() {
  const start = (currentUrlPage - 1) * DOMAIN_GROUPS_PER_PAGE;
  return urlGroupsCache.slice(start, start + DOMAIN_GROUPS_PER_PAGE);
}

function hideDuplicatePanel(panelId, onHide) {
  const panel = document.getElementById(panelId);
  panel.classList.add('hidden');
  panel.innerHTML = '';
  onHide?.();
}

function updateDomainSelectionState(container) {
  const confirmBtn = container.querySelector('#confirmDomainDup');
  const count = selectedDomainGroups.size;
  confirmBtn.disabled = count === 0;
  confirmBtn.textContent = count ? `关闭所选主站 (${count})` : '关闭所选主站';

  container.querySelectorAll('.domain-card').forEach(card => {
    card.classList.toggle('selected', selectedDomainGroups.has(card.dataset.domain));
  });
}

function renderDomainDupPanel() {
  const panel = document.getElementById('domainDupPanel');
  if (!domainGroupsCache.length) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const pageCount = getDomainPageCount();
  currentDomainPage = Math.min(Math.max(currentDomainPage, 1), pageCount);
  const visibleGroups = getDomainPageGroups();

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="domain-panel-shell card">
      <div class="domain-panel-head">
        <div>
          <h2>重复主站域名</h2>
          <p>每张卡片是一组主站域名。默认保留最近访问的一个标签页，其余会在确认后关闭。当前按页查看，避免一次堆太多组。</p>
        </div>
        <div class="domain-panel-actions">
          <button id="selectAllDomainDup" class="btn secondary">全选</button>
          <button id="clearDomainDupSelection" class="btn tertiary">清空</button>
          <button id="confirmDomainDup" class="btn primary">关闭所选主站</button>
          <button id="cancelDomainDup" class="btn tertiary">收起</button>
        </div>
      </div>
      <div class="domain-pagebar">
        <span class="page-chip">共 ${domainGroupsCache.length} 组主站</span>
        <span class="page-chip">第 ${currentDomainPage} / ${pageCount} 页</span>
        <div class="page-actions">
          <button id="prevDomainPage" class="btn tertiary" ${currentDomainPage === 1 ? 'disabled' : ''}>上一页</button>
          <button id="nextDomainPage" class="btn tertiary" ${currentDomainPage === pageCount ? 'disabled' : ''}>下一页</button>
        </div>
      </div>
      <div class="domain-card-grid">
        ${visibleGroups.map(buildDomainCard).join('')}
      </div>
    </div>`;

  panel.querySelectorAll('.domain-dup-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedDomainGroups.add(cb.dataset.domain);
      else selectedDomainGroups.delete(cb.dataset.domain);
      updateDomainSelectionState(panel);
    });
  });

  panel.querySelector('#selectAllDomainDup').addEventListener('click', () => {
    selectedDomainGroups = new Set(domainGroupsCache.map(group => group.domain));
    panel.querySelectorAll('.domain-dup-checkbox').forEach(cb => { cb.checked = true; });
    updateDomainSelectionState(panel);
  });

  panel.querySelector('#clearDomainDupSelection').addEventListener('click', () => {
    selectedDomainGroups.clear();
    panel.querySelectorAll('.domain-dup-checkbox').forEach(cb => { cb.checked = false; });
    updateDomainSelectionState(panel);
  });

  panel.querySelector('#cancelDomainDup').addEventListener('click', () => {
    hideDuplicatePanel('domainDupPanel', () => {
      selectedDomainGroups.clear();
    });
  });

  panel.querySelector('#confirmDomainDup').addEventListener('click', async () => {
    const domains = [...selectedDomainGroups];
    if (!domains.length) return;
    const before = (await send('GET_ALL_TABS')) || [];
    const memBefore = before.reduce((s, t) => s + (t.memory || 0), 0);
    const res = (await send('CLOSE_DOMAIN_DUPS', { domains })) || { closed: 0 };
    const after = (await send('GET_ALL_TABS')) || [];
    const saved = memBefore - after.reduce((s, t) => s + (t.memory || 0), 0);
    showToast(`已关闭 ${res.closed} 个重复标签页${saved > 0 ? `，释放约 ${memStr(saved)}` : ''}`);
    await loadOverview();
    await openDomainDupPanel(true);
  });

  panel.querySelector('#prevDomainPage').addEventListener('click', () => {
    if (currentDomainPage === 1) return;
    currentDomainPage -= 1;
    renderDomainDupPanel();
  });

  panel.querySelector('#nextDomainPage').addEventListener('click', () => {
    if (currentDomainPage === pageCount) return;
    currentDomainPage += 1;
    renderDomainDupPanel();
  });

  bindJumpLinks(panel);
  bindTabCloseActions(panel, async () => {
    await loadOverview();
    await openDomainDupPanel(true);
  });
  updateDomainSelectionState(panel);
}

async function openDomainDupPanel(preserveSelection = false) {
  const groups = (await send('GET_DOMAIN_DUPLICATES')) || [];
  const panel = document.getElementById('domainDupPanel');
  hideDuplicatePanel('urlDupPanel', () => {
    selectedUrlGroups.clear();
    urlGroupsCache = [];
  });

  if (!groups.length) {
    domainGroupsCache = [];
    panel.classList.add('hidden');
    panel.innerHTML = '';
    if (!preserveSelection) showToast('没有发现可按主站归类的重复标签页');
    return;
  }

  const previousSelection = preserveSelection ? new Set(selectedDomainGroups) : null;
  domainGroupsCache = groups;
  selectedDomainGroups = previousSelection
    ? new Set(groups.map(group => group.domain).filter(domain => previousSelection.has(domain)))
    : new Set(groups.map(group => group.domain));

  if (preserveSelection && previousSelection?.size && !selectedDomainGroups.size) {
    selectedDomainGroups = new Set(groups.map(group => group.domain));
  }

  currentDomainPage = preserveSelection ? Math.min(currentDomainPage, getDomainPageCount()) : 1;
  renderDomainDupPanel();
}

function updateUrlSelectionState(container) {
  const confirmBtn = container.querySelector('#confirmUrlDup');
  const count = selectedUrlGroups.size;
  confirmBtn.disabled = count === 0;
  confirmBtn.textContent = count ? `关闭所选 URL 组 (${count})` : '关闭所选 URL 组';

  container.querySelectorAll('.domain-card').forEach(card => {
    card.classList.toggle('selected', selectedUrlGroups.has(card.dataset.url));
  });
}

function renderUrlDupPanel() {
  const panel = document.getElementById('urlDupPanel');
  if (!urlGroupsCache.length) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const pageCount = getUrlPageCount();
  currentUrlPage = Math.min(Math.max(currentUrlPage, 1), pageCount);
  const visibleGroups = getUrlPageGroups();

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="domain-panel-shell card">
      <div class="domain-panel-head">
        <div>
          <h2>完全重复 URL</h2>
          <p>每张卡片是一组完全相同的链接。默认保留优先级最高的一个标签页，其余会在确认后关闭。</p>
        </div>
        <div class="domain-panel-actions">
          <button id="selectAllUrlDup" class="btn secondary">全选</button>
          <button id="clearUrlDupSelection" class="btn tertiary">清空</button>
          <button id="confirmUrlDup" class="btn primary">关闭所选 URL 组</button>
          <button id="cancelUrlDup" class="btn tertiary">收起</button>
        </div>
      </div>
      <div class="domain-pagebar">
        <span class="page-chip">共 ${urlGroupsCache.length} 组完全重复 URL</span>
        <span class="page-chip">第 ${currentUrlPage} / ${pageCount} 页</span>
        <div class="page-actions">
          <button id="prevUrlPage" class="btn tertiary" ${currentUrlPage === 1 ? 'disabled' : ''}>上一页</button>
          <button id="nextUrlPage" class="btn tertiary" ${currentUrlPage === pageCount ? 'disabled' : ''}>下一页</button>
        </div>
      </div>
      <div class="domain-card-grid">
        ${visibleGroups.map(buildUrlDuplicateCard).join('')}
      </div>
    </div>`;

  panel.querySelectorAll('.url-dup-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedUrlGroups.add(cb.dataset.url);
      else selectedUrlGroups.delete(cb.dataset.url);
      updateUrlSelectionState(panel);
    });
  });

  panel.querySelector('#selectAllUrlDup').addEventListener('click', () => {
    selectedUrlGroups = new Set(urlGroupsCache.map(group => group.url));
    panel.querySelectorAll('.url-dup-checkbox').forEach(cb => { cb.checked = true; });
    updateUrlSelectionState(panel);
  });

  panel.querySelector('#clearUrlDupSelection').addEventListener('click', () => {
    selectedUrlGroups.clear();
    panel.querySelectorAll('.url-dup-checkbox').forEach(cb => { cb.checked = false; });
    updateUrlSelectionState(panel);
  });

  panel.querySelector('#cancelUrlDup').addEventListener('click', () => {
    hideDuplicatePanel('urlDupPanel', () => {
      selectedUrlGroups.clear();
    });
  });

  panel.querySelector('#confirmUrlDup').addEventListener('click', async () => {
    const urls = [...selectedUrlGroups];
    if (!urls.length) return;
    const before = (await send('GET_ALL_TABS')) || [];
    const memBefore = before.reduce((s, t) => s + (t.memory || 0), 0);
    const res = (await send('CLOSE_DUPLICATES', { urls })) || { closed: 0 };
    const after = (await send('GET_ALL_TABS')) || [];
    const saved = memBefore - after.reduce((s, t) => s + (t.memory || 0), 0);
    showToast(`已关闭 ${res.closed} 个重复标签页${saved > 0 ? `，释放约 ${memStr(saved)}` : ''}`);
    await loadOverview();
    await openUrlDupPanel(true);
  });

  panel.querySelector('#prevUrlPage').addEventListener('click', () => {
    if (currentUrlPage === 1) return;
    currentUrlPage -= 1;
    renderUrlDupPanel();
  });

  panel.querySelector('#nextUrlPage').addEventListener('click', () => {
    if (currentUrlPage === pageCount) return;
    currentUrlPage += 1;
    renderUrlDupPanel();
  });

  bindJumpLinks(panel);
  bindTabCloseActions(panel, async () => {
    await loadOverview();
    await openUrlDupPanel(true);
  });
  updateUrlSelectionState(panel);
}

async function openUrlDupPanel(preserveSelection = false) {
  const groups = (await send('GET_URL_DUPLICATES')) || [];
  const panel = document.getElementById('urlDupPanel');
  hideDuplicatePanel('domainDupPanel', () => {
    selectedDomainGroups.clear();
    domainGroupsCache = [];
  });

  if (!groups.length) {
    urlGroupsCache = [];
    panel.classList.add('hidden');
    panel.innerHTML = '';
    if (!preserveSelection) showToast('没有发现完全重复的 URL 标签页');
    return;
  }

  const previousSelection = preserveSelection ? new Set(selectedUrlGroups) : null;
  urlGroupsCache = groups;
  selectedUrlGroups = previousSelection
    ? new Set(groups.map(group => group.url).filter(url => previousSelection.has(url)))
    : new Set(groups.map(group => group.url));

  if (preserveSelection && previousSelection?.size && !selectedUrlGroups.size) {
    selectedUrlGroups = new Set(groups.map(group => group.url));
  }

  currentUrlPage = preserveSelection ? Math.min(currentUrlPage, getUrlPageCount()) : 1;
  renderUrlDupPanel();
}

async function loadOverview() {
  selectedIds.clear();
  updateCloseSelected();
  const tabs = (await send('GET_ALL_TABS')) || [];
  const sleeping = tabs.filter(tab => tab.discarded).length;
  const totalMem = tabs.reduce((s, t) => s + (t.memory || 0), 0);
  const query = normalizeQuery(document.getElementById('overviewSearch')?.value);
  const filteredTabs = tabs.filter(tab => matchesTabQuery(tab, query));
  document.getElementById('overviewCount').innerHTML =
    `共 <b>${tabs.length}</b> 个标签页 <span class="dot"></span> 休眠 <b>${sleeping}</b> 个` +
    (totalMem ? ` <span class="dot"></span> JS堆内存 <b>${memStr(totalMem)}</b>` : '');

  const list = document.getElementById('tabList');
  const byWindow = filteredTabs.reduce((acc, tab) => {
    (acc[tab.windowId] = acc[tab.windowId] || []).push(tab);
    return acc;
  }, {});
  const windowIds = Object.keys(byWindow);
  list.innerHTML = windowIds.length === 0
    ? '<li class="empty">没有匹配的标签页</li>'
    : windowIds.map((wid, i) => `
        <li class="window-group-header">窗口 ${i + 1}（${byWindow[wid].length} 个标签页）</li>
        ${byWindow[wid].map(tab => buildTabRow(tab, { selectable: true })).join('')}
      `).join('');

  bindTabSelection(list);
  bindJumpLinks(list);
  bindTabCloseActions(list, loadOverview);
}

document.getElementById('closeSelected').addEventListener('click', async () => {
  await chrome.tabs.remove([...selectedIds]);
  await loadOverview();
});

document.getElementById('closeDupsBtn').addEventListener('click', async () => {
  await openUrlDupPanel(false);
});

document.getElementById('closeDomainDupsBtn').addEventListener('click', async () => {
  await openDomainDupPanel(false);
});

async function loadSleep() {
  const tabs = (await send('GET_ALL_TABS')) || [];
  const sleeping = tabs.filter(tab => tab.discarded);
  const query = normalizeQuery(document.getElementById('sleepSearch')?.value);
  const filteredSleeping = sleeping.filter(tab => matchesTabQuery(tab, query));
  document.getElementById('sleepCount').textContent = `${sleeping.length} 个标签页处于休眠状态`;

  const list = document.getElementById('sleepList');
  list.innerHTML = filteredSleeping.map(tab => `
    <li class="item-row">
      <img src="${favicon(tab.url || '', tab.favIconUrl)}" onerror="this.style.display='none'">
      <div class="item-main">
        <div class="item-title-row">
          <a class="jump-link" data-id="${tab.id}" data-wid="${tab.windowId}" title="${escAttr(tab.url)}">${escHtml(tab.title || tab.url || '(无标题)')}</a>
          <button class="ghost-action" data-wake-tab="${tab.id}">唤醒</button>
        </div>
        <div class="item-url">${escHtml(tab.url || '')}</div>
        <div class="item-meta">
          <span class="meta-pill">已记录 ${durationText(tab.firstSeenAt)}</span>
          <span class="meta-pill">最近访问 ${timeAgo(tab.lastActiveAt)}</span>
        </div>
      </div>
    </li>
  `).join('') || '<li class="empty">没有匹配的休眠标签页</li>';

  bindJumpLinks(list);
  list.querySelectorAll('[data-wake-tab]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await chrome.tabs.update(Number(btn.dataset.wakeTab), { active: true });
      await new Promise(r => setTimeout(r, 100));
      await loadSleep();
    });
  });
}

document.getElementById('wakeAll').addEventListener('click', async () => {
  const tabs = (await send('GET_ALL_TABS')) || [];
  await Promise.allSettled(tabs.filter(item => item.discarded).map(tab => chrome.tabs.reload(tab.id)));
  await new Promise(r => setTimeout(r, 100));
  await loadSleep();
});

let allHistory = [];

async function loadHistory() {
  allHistory = (await send('GET_HISTORY')) || [];
  renderHistory(allHistory);
}

function renderHistory(items) {
  const list = document.getElementById('historyList');
  list.innerHTML = items.map(item => {
    const safeFavicon = favicon(item.url, item.favicon?.startsWith('http') ? item.favicon : '');
    return `
    <li class="item-row">
      <img src="${safeFavicon}" onerror="this.style.display='none'">
      <div class="item-main">
        <div class="item-title-row">
          <span class="plain-title">${escHtml(item.title || item.url)}</span>
          <button class="ghost-action" data-restore-url="${escAttr(item.url)}">恢复</button>
        </div>
        <div class="item-url">${escHtml(item.url)}</div>
        <div class="item-meta">
          <span class="meta-pill">关闭于 ${timeAgo(item.closedAt)}</span>
        </div>
      </div>
    </li>`;
  }).join('') || '<li class="empty">暂无关闭记录</li>';

  list.querySelectorAll('[data-restore-url]').forEach(btn => {
    btn.addEventListener('click', () => send('RESTORE_TAB', { url: btn.dataset.restoreUrl }));
  });
}

document.getElementById('historySearch').addEventListener('input', e => {
  const query = normalizeQuery(e.target.value);
  renderHistory(query
    ? allHistory.filter(item => item.url.toLowerCase().includes(query) || (item.title || '').toLowerCase().includes(query))
    : allHistory);
});

document.getElementById('overviewSearch').addEventListener('input', () => {
  loadOverview();
});

document.getElementById('sleepSearch').addEventListener('input', () => {
  loadSleep();
});

document.getElementById('exportHistory').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(allHistory, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tabtrim-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

document.getElementById('clearHistory').addEventListener('click', async () => {
  if (!confirm('确认清空所有关闭历史？')) return;
  await chrome.storage.local.set({ closedHistory: [] });
  loadHistory();
});

async function loadSettings() {
  const settings = (await send('GET_SETTINGS')) || {};
  document.getElementById('sleepThreshold').value = settings.sleepThresholdMinutes;
  document.getElementById('sleepEnabled').checked = settings.sleepEnabled;
  document.getElementById('autoDedupEnabled').checked = settings.autoDedupEnabled;
  document.getElementById('autoDedupInterval').value = String(settings.autoDedupIntervalMinutes || 30);
}

document.getElementById('saveSettings').addEventListener('click', async () => {
  const settings = {
    sleepThresholdMinutes: Number(document.getElementById('sleepThreshold').value) || 60,
    sleepEnabled: document.getElementById('sleepEnabled').checked,
    autoDedupEnabled: document.getElementById('autoDedupEnabled').checked,
    autoDedupIntervalMinutes: Number(document.getElementById('autoDedupInterval').value) || 30
  };
  await send('SAVE_SETTINGS', { settings });
  showToast('设置已保存');
});

function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

waitForServiceWorker().then(() => loadOverview());
