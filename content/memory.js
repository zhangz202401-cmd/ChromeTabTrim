// 上报当前页面内存占用（performance.memory 是 Chrome 专有 API）
function report() {
  const mem = performance.memory;
  if (!mem) return;
  chrome.runtime.sendMessage({
    type: 'TAB_MEMORY',
    usedJSHeapSize: mem.usedJSHeapSize,
    totalJSHeapSize: mem.totalJSHeapSize
  }).catch(() => {});
}

report();
setInterval(report, 30000);
