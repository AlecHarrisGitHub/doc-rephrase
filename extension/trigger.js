// No document extraction, network requests, clipboard access, or key storage.
// The shortcut only activates the Google Docs custom menu.
(async () => {
  if (window.__docRephraseTriggerBusy) return {ok: true};
  window.__docRephraseTriggerBusy = true;
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const label = element => (element.querySelector('.goog-menuitem-content') || element).textContent.trim().replace(/\s+/g, ' ');
  const find = (selector, name) => Array.from(document.querySelectorAll(selector)).find(el => visible(el) && label(el) === name);
  const click = element => {
    // Closure menus react to a complete mouse sequence; synthetic clicks alone can be ignored.
    const box = element.getBoundingClientRect();
    const options = {bubbles: true, cancelable: true, view: window, button: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2};
    element.dispatchEvent(new MouseEvent('mousedown', {...options, buttons: 1}));
    element.dispatchEvent(new MouseEvent('mouseup', {...options, buttons: 0}));
    element.dispatchEvent(new MouseEvent('click', options));
  };
  const notice = message => {
    document.getElementById('doc-rephrase-shortcut-notice')?.remove();
    const div = document.createElement('div'); div.id = 'doc-rephrase-shortcut-notice';
    div.setAttribute('role', 'status'); div.textContent = message;
    Object.assign(div.style, {position: 'fixed', top: '100px', right: '24px', zIndex: '2147483647', maxWidth: '360px',
      padding: '16px', borderRadius: '10px', background: '#183c30', color: 'white', font: '14px/1.5 system-ui', boxShadow: '0 4px 24px #0003'});
    document.body.appendChild(div); setTimeout(() => div.remove(), 9000);
  };
  try {
    const menu = find('[role="menubar"] [role="button"], [role="menubar"] [role="menuitem"], .goog-menu-button', 'Doc Rephrase');
    if (!menu) {
      notice('Install the Doc Rephrase Apps Script in this document and reload it. Look for the “Doc Rephrase” menu above.');
      return {ok: false};
    }
    let item = find('[role="menuitem"]', 'Rephrase selection');
    if (!item) click(menu);
    for (let attempt = 0; attempt < 25; attempt++) {
      item = find('[role="menuitem"]', 'Rephrase selection');
      if (item) { click(item); return {ok: true}; }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    notice('The shortcut could not open the action. Choose Doc Rephrase → Rephrase selection from the menu.');
    return {ok: false};
  } finally { window.__docRephraseTriggerBusy = false; }
})();
