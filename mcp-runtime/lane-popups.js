// Injected into every page of an authenticated agent session by
// browser-mcp-server (Playwright MCP --init-script). Page-initiated new tabs
// (target=_blank anchors, featureless window.open) make Chromium call Show()
// on the window that receives them, which on macOS activates that window; an
// agent lane must never become Chrome's key window. Such opens are therefore
// turned into same-tab navigations. window.open with explicit window features
// still opens a real popup window; the extension removes that spill and fails
// the session closed, exactly as before.
(() => {
  if (window.__laneNoPopupsInstalled)
    return;
  Object.defineProperty(window, '__laneNoPopupsInstalled', { value: true, configurable: false });
  const nativeOpen = window.open.bind(window);
  window.open = function laneOpen(url, target, features) {
    if (typeof features === 'string' && features.trim() !== '')
      return nativeOpen(url, target, features);
    if (target === '_self' || target === '_top' || target === '_parent')
      return nativeOpen(url, target, features);
    if (url !== undefined && url !== null && String(url) !== '' && String(url) !== 'about:blank')
      window.location.assign(String(url));
    return window;
  };
  document.addEventListener('click', event => {
    const anchor = event.target && typeof event.target.closest === 'function' ? event.target.closest('a[target]') : null;
    if (!anchor)
      return;
    const target = (anchor.getAttribute('target') || '').toLowerCase();
    if (target === '_blank' || target === '_new' || (target && !['_self', '_top', '_parent'].includes(target)))
      anchor.setAttribute('target', '_self');
  }, true);
  document.addEventListener('submit', event => {
    const form = event.target;
    if (form && typeof form.getAttribute === 'function') {
      const target = (form.getAttribute('target') || '').toLowerCase();
      if (target === '_blank' || target === '_new')
        form.setAttribute('target', '_self');
    }
  }, true);
})();
