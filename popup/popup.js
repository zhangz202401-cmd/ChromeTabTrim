async function send(type, data = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await chrome.runtime.sendMessage({ type, ...data });
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 200));
    }
  }
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

async function init() {
  const stats = await send('GET_STATS');
  document.getElementById('totalCount').textContent = stats.total;
  document.getElementById('dupCount').textContent = stats.duplicateCount;
  document.getElementById('sleepCount').textContent = stats.sleepCount;

  const btn = document.getElementById('closeDups');
  btn.disabled = stats.duplicateCount === 0;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const res = await send('CLOSE_DUPLICATES');
      btn.textContent = res?.closed ? `已关闭 ${res.closed} 个重复标签页` : '没有发现重复标签页';
      setTimeout(init, 900);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '操作失败';
    }
  };

  const list = document.getElementById('historyList');
  if (!stats.recentHistory.length) {
    list.innerHTML = '<li class="empty">暂无关闭记录</li>';
    return;
  }

  list.innerHTML = stats.recentHistory.map(item => {
    const safeFavicon = /^https:\/\/www\.google\.com\/s2\/favicons\?/.test(item.favicon) ? item.favicon : '';
    return `
    <li data-url="${escAttr(item.url)}">
      ${safeFavicon ? `<img src="${safeFavicon}" onerror="this.style.display='none'">` : ''}
      <span class="history-title" title="${escAttr(item.url)}">${escHtml(item.title || item.url)}</span>
      <span class="history-action">恢复</span>
    </li>`;
  }).join('');

  list.querySelectorAll('li[data-url]').forEach(item => {
    item.addEventListener('click', () => send('RESTORE_TAB', { url: item.dataset.url }));
  });
}

document.getElementById('openManager').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
});

init();
