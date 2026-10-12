// Small UI helpers: toasts and bottom sheets.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

/**
 * Open a sheet. `html` is the inner markup; `setup(sheetEl, close)` wires it up.
 * Returns a promise resolved with whatever is passed to close().
 */
export function sheet(html, setup) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    const el = backdrop.firstElementChild;
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(undefined); }
    };
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(undefined); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    setup?.(el, close);
    el.querySelector('[autofocus]')?.focus();
  });
}

/** A simple action menu. items: [{label, value, danger}] */
export function menu(title, items) {
  return sheet(
    `${title ? `<h3>${esc(title)}</h3>` : ''}<div class="menu">${items
      .map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`)
      .join('')}<button data-i="-1">Cancel</button></div>`,
    (el, close) => {
      el.querySelectorAll('[data-i]').forEach((b) =>
        b.addEventListener('click', () => close(items[+b.dataset.i]?.value)),
      );
    },
  );
}

export function confirmSheet(title, message, okLabel = 'Delete') {
  return sheet(
    `<h3>${esc(title)}</h3><p class="sub">${esc(message)}</p>
     <div class="actions"><button class="btn" data-no>Cancel</button><button class="btn danger" data-yes>${esc(okLabel)}</button></div>`,
    (el, close) => {
      el.querySelector('[data-no]').onclick = () => close(false);
      el.querySelector('[data-yes]').onclick = () => close(true);
    },
  );
}
