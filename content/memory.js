function report() {
  const mem = performance?.memory;
  if (!mem?.usedJSHeapSize) return;
  chrome.runtime.sendMessage({
    type: 'TAB_MEMORY',
    usedJSHeapSize: mem.usedJSHeapSize,
    totalJSHeapSize: mem.totalJSHeapSize
  }).catch(() => {});
}

report();
setInterval(report, 30000);
