import { api } from './api.js';
import { inspectPdf } from './pdf.js';
import { Reader } from './reader.js';
import { esc, sheet, menu, confirmSheet, toast } from './ui.js';
import { starsHtml, fmtRating, reviewSheet } from './social.js';

const app = document.getElementById('app');
const tpl = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

const state = {
  user: null,
  books: [],
  query: '',
  sort: localStorage.getItem('bindr:sort') || 'recent',
  uploads: [], // in-flight uploads: {key, title, author, coverUrl, progress}
  reader: null,
};

// ------------------------------------------------------------------ boot
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

boot();

async function boot() {
  try {
    const { user } = await api.me();
    state.user = user;
    localStorage.setItem('bindr:user', JSON.stringify(user));
  } catch (e) {
    // Offline but previously signed in: show the cached library.
    const cached = e.offline && localStorage.getItem('bindr:user');
    if (cached) state.user = JSON.parse(cached);
  }
  if (!state.user) return showAuth();
  await loadBooks();
  route();
}

window.addEventListener('popstate', () => state.user && route());

function route() {
  const m = location.pathname.match(/^\/read\/([\w-]+)/);
  if (m) {
    const book = state.books.find((b) => b.id === m[1]);
    if (book) return showReader(book);
    history.replaceState(null, '', '/');
  }
  showLibrary();
}

let pushedReader = false;

function navigate(path) {
  if (location.pathname !== path) {
    history.pushState(null, '', path);
    pushedReader = path.startsWith('/read/');
  }
  route();
}

// ------------------------------------------------------------------ auth
function showAuth() {
  closeReader();
  const view = tpl('tpl-auth');
  app.replaceChildren(view);
  document.title = 'Bindr';
  let mode = 'login';
  const form = view.querySelector('form');
  const err = view.querySelector('.form-error');
  const submit = form.querySelector('[type="submit"]');
  const setMode = (m) => {
    mode = m;
    view.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    view.querySelector('.only-register').hidden = m !== 'register';
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    form.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    err.textContent = '';
  };
  view.querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const { email, password, name } = form;
      const { user } = mode === 'login'
        ? await api.login(email.value.trim(), password.value)
        : await api.register(name.value.trim(), email.value.trim(), password.value);
      state.user = user;
      localStorage.setItem('bindr:user', JSON.stringify(user));
      await loadBooks();
      history.replaceState(null, '', '/');
      route();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  };
}

async function signOut() {
  try { await api.logout(); } catch {}
  state.user = null;
  state.books = [];
  localStorage.removeItem('bindr:user');
  localStorage.removeItem('bindr:books');
  if ('caches' in window) await caches.delete('bindr-books').catch(() => {});
  history.replaceState(null, '', '/');
  showAuth();
}

// ------------------------------------------------------------------ data
async function loadBooks() {
  try {
    const { books } = await api.books();
    state.books = books;
    localStorage.setItem('bindr:books', JSON.stringify(books));
  } catch (e) {
    if (e.status === 401) { state.user = null; return; }
    state.books = JSON.parse(localStorage.getItem('bindr:books') || '[]');
    if (e.offline) toast('Offline: showing your saved library.');
  }
}

function saveBooksLocal() {
  localStorage.setItem('bindr:books', JSON.stringify(state.books));
}

function replaceBook(book) {
  const i = state.books.findIndex((b) => b.id === book.id);
  if (i >= 0) state.books[i] = book; else state.books.unshift(book);
  saveBooksLocal();
}

// ------------------------------------------------------------------ library
let libView = null;

function showLibrary() {
  closeReader();
  if (!state.user) return showAuth();
  document.title = 'Library · Bindr';
  libView = tpl('tpl-library');
  app.replaceChildren(libView);

  const avatar = libView.querySelector('.avatar');
  avatar.textContent = (state.user.name || state.user.email || '?').trim()[0].toUpperCase();
  avatar.onclick = accountSheet;

  const fileInput = libView.querySelector('.file-input');
  libView.querySelectorAll('[data-action="upload"]').forEach((b) => (b.onclick = () => fileInput.click()));
  fileInput.onchange = () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) startUpload(files);
  };

  const search = libView.querySelector('.search input');
  search.value = state.query;
  search.oninput = () => { state.query = search.value; renderShelf(); };
  const sort = libView.querySelector('.sort');
  sort.value = state.sort;
  sort.onchange = () => { state.sort = sort.value; localStorage.setItem('bindr:sort', sort.value); renderShelf(); };

  // Drag & drop anywhere on the library.
  const overlay = libView.querySelector('.drop-overlay');
  let depth = 0;
  libView.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; overlay.hidden = false; } });
  libView.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  libView.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  libView.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) startUpload(files);
  });

  renderShelf();
}

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

function sortedBooks() {
  const q = state.query.trim().toLowerCase();
  let list = state.books.filter((b) => !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));
  const by = {
    recent: (a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
    author: (a, b) => (a.author || '￿').localeCompare(b.author || '￿') || a.title.localeCompare(b.title),
    added: (a, b) => b.createdAt - a.createdAt,
  }[state.sort];
  return list.sort(by);
}

function coverHtml(book) {
  const img = book.hasCover ? `<img src="${api.coverUrl(book)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="cover"><div class="placeholder">${esc(book.title)}</div>${img}</div>`;
}

function progressPct(book) {
  if (!book.pageCount || !book.lastOpenedAt) return null;
  return Math.round((book.currentPage / book.pageCount) * 100);
}

function renderShelf() {
  if (!libView) return;
  const grid = libView.querySelector('.grid');
  const books = sortedBooks();
  const searching = !!state.query.trim();

  // Continue reading
  const recent = state.books.filter((b) => b.lastOpenedAt).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  const cont = libView.querySelector('.continue');
  cont.hidden = !recent || searching;
  if (recent && !searching) {
    const pct = progressPct(recent) ?? 0;
    const card = cont.querySelector('.continue-card');
    card.innerHTML = `${coverHtml(recent)}<div class="meta">
      <div class="t">${esc(recent.title)}</div>
      ${recent.author ? `<div class="a">${esc(recent.author)}</div>` : ''}
      <div class="a">Page ${recent.currentPage} of ${recent.pageCount || '?'} · ${pct}%</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <button class="btn primary">Continue</button></div>`;
    card.onclick = () => navigate(`/read/${recent.id}`);
  }

  const uploads = state.uploads.map((u) => `
    <div class="book uploading">
      <div class="cover"><div class="placeholder">${esc(u.title)}</div>${u.coverUrl ? `<img src="${u.coverUrl}" alt="">` : ''}
        <div class="progress upload-bar"><div style="width:${Math.round(u.progress * 100)}%"></div></div></div>
      <div class="book-info"><div class="book-text"><div class="book-title">${esc(u.title)}</div>
      <div class="book-sub">Uploading… ${Math.round(u.progress * 100)}%</div></div></div>
    </div>`).join('');

  grid.innerHTML = uploads + books.map((b) => {
    const pct = progressPct(b);
    const sub = pct === null ? '<span class="new">NEW</span>' : pct >= 100 ? 'Finished' : `${pct}%`;
    return `<div class="book" data-id="${esc(b.id)}">
      <button class="book-open" aria-label="Open ${esc(b.title)}">${coverHtml(b)}</button>
      <div class="book-info">
        <div class="book-text">
          <div class="book-title" title="${esc(b.title)}">${esc(b.title)}</div>
          <div class="book-sub">${sub}${b.author ? ` · ${esc(b.author)}` : ''}</div>
          ${b.rating ? `<div class="book-meta">${starsHtml(b.rating, 11)}<span>${fmtRating(b.rating)}</span></div>` : ''}
        </div>
        <button class="more" aria-label="More options for ${esc(b.title)}">
          <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.book[data-id]').forEach((el) => {
    const book = state.books.find((b) => b.id === el.dataset.id);
    bindBookGestures(el, book);
    el.querySelector('.more').onclick = () => bookMenu(book);
  });

  const empty = libView.querySelector('.empty');
  empty.hidden = state.books.length > 0 || state.uploads.length > 0;
  libView.querySelector('.shelf-title').hidden = !empty.hidden;
  libView.querySelector('.shelf-title').textContent = searching ? `Results (${books.length})` : 'All Books';
}

/**
 * Tap opens the book; double-tap or press-and-hold opens Rate & Review;
 * right-click opens the menu.
 */
function bindBookGestures(el, book) {
  const btn = el.querySelector('.book-open');
  let openTimer = null;
  let pressTimer = null;
  let longPressed = false;
  let pointerType = 'mouse';
  let start = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  btn.addEventListener('pointerdown', (e) => {
    pointerType = e.pointerType;
    if (e.button !== 0) return;
    longPressed = false;
    start = [e.clientX, e.clientY];
    pressTimer = setTimeout(() => {
      longPressed = true;
      navigator.vibrate?.(12);
      clearTimeout(openTimer);
      openTimer = null;
      rateBook(book);
    }, 520);
  });
  btn.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) cancelPress();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => btn.addEventListener(t, cancelPress));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (longPressed) { longPressed = false; return; }
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
      rateBook(book);
      return;
    }
    openTimer = setTimeout(() => { openTimer = null; navigate(`/read/${book.id}`); }, 280);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (pointerType === 'mouse') bookMenu(book); // touch long-presses are handled above
  });
}

async function rateBook(book) {
  const updated = await reviewSheet(book);
  if (updated) { replaceBook(updated); renderShelf(); }
}

async function bookMenu(book) {
  const choice = await menu(book.title, [
    { label: 'Read', value: 'read' },
    { label: book.rating ? `Rate & Review (${fmtRating(book.rating)} ★)` : 'Rate & Review', value: 'rate' },
    { label: 'Rename / Edit Details', value: 'rename' },
    { label: 'Mark as Unread', value: 'reset' },
    { label: 'Remove from Library', value: 'delete', danger: true },
  ]);
  if (choice === 'read') navigate(`/read/${book.id}`);
  if (choice === 'rename') renameBook(book);
  if (choice === 'rate') rateBook(book);
  if (choice === 'reset') {
    try {
      replaceBook((await api.updateBook(book.id, { reset: true })).book);
      renderShelf();
    } catch (e) { toast(e.message); }
  }
  if (choice === 'delete') {
    const ok = await confirmSheet('Remove this book?', `“${book.title}” will be deleted from your cloud library on all devices.`, 'Remove');
    if (!ok) return;
    try {
      await api.deleteBook(book.id);
      state.books = state.books.filter((b) => b.id !== book.id);
      saveBooksLocal();
      window.caches?.open('bindr-books').then((c) => c.delete(api.fileUrl(book.id))).catch(() => {});
      renderShelf();
      toast('Book removed.');
    } catch (e) { toast(e.message); }
  }
}

function renameBook(book) {
  return sheet(
    `<h3>Edit Details</h3><p class="sub">This is how the book appears in your library.</p>
     <form>
       <label class="field"><span>Title</span><input name="title" maxlength="200" required value="${esc(book.title)}" autofocus></label>
       <label class="field"><span>Author</span><input name="author" maxlength="200" value="${esc(book.author)}" placeholder="Optional"></label>
       <p class="form-error"></p>
       <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>
     </form>`,
    (el, close) => {
      const form = el.querySelector('form');
      el.querySelector('[data-cancel]').onclick = () => close();
      form.title.select();
      form.onsubmit = async (e) => {
        e.preventDefault();
        const title = form.title.value.trim();
        if (!title) { el.querySelector('.form-error').textContent = 'Title cannot be empty.'; return; }
        try {
          replaceBook((await api.updateBook(book.id, { title, author: form.author.value.trim() })).book);
          renderShelf();
          close();
        } catch (ex) {
          el.querySelector('.form-error').textContent = ex.message;
        }
      };
    },
  );
}

// ------------------------------------------------------------------ upload
async function startUpload(files) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdfs.length < files.length) toast('Only PDF files can be added.');
  if (!pdfs.length) return;

  // Read metadata + covers so the user can name each book before uploading.
  const items = await Promise.all(pdfs.map(async (file) => {
    const fallback = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
    try {
      const info = await inspectPdf(file);
      return { file, ...info, title: info.title || fallback, coverUrl: info.cover && URL.createObjectURL(info.cover) };
    } catch (e) {
      console.warn('Could not read PDF', file.name, e);
      return { file, title: fallback, author: '', pageCount: 0, cover: null, broken: true };
    }
  }));

  const valid = items.filter((it) => !it.broken);
  if (valid.length < items.length) toast(`${items.length - valid.length} file(s) could not be read as PDFs.`);
  if (!valid.length) return;

  const confirmed = await sheet(
    `<h3>Add ${valid.length === 1 ? 'Book' : `${valid.length} Books`}</h3>
     <p class="sub">Choose how ${valid.length === 1 ? 'it appears' : 'they appear'} in your library. You can change this later.</p>
     <form>${valid.map((it, i) => `
       <div class="upload-item">
         <div class="cover"><div class="placeholder">${esc(it.title)}</div>${it.coverUrl ? `<img src="${it.coverUrl}" alt="">` : ''}</div>
         <div class="fields">
           <div class="fname">${esc(it.file.name)} · ${(it.file.size / 1048576).toFixed(1)} MB${it.pageCount ? ` · ${it.pageCount} pages` : ''}</div>
           <label class="field"><span>Title</span><input name="title-${i}" maxlength="200" required value="${esc(it.title)}" ${i === 0 ? 'autofocus' : ''}></label>
           <label class="field"><span>Author</span><input name="author-${i}" maxlength="200" value="${esc(it.author)}" placeholder="Optional"></label>
         </div>
       </div>`).join('')}
       <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Add to Library</button></div>
     </form>`,
    (el, close) => {
      const form = el.querySelector('form');
      el.querySelector('[data-cancel]').onclick = () => close(false);
      form.onsubmit = (e) => {
        e.preventDefault();
        valid.forEach((it, i) => {
          it.title = form[`title-${i}`].value.trim() || it.title;
          it.author = form[`author-${i}`].value.trim();
        });
        close(true);
      };
    },
  );
  if (!confirmed) {
    valid.forEach((it) => it.coverUrl && URL.revokeObjectURL(it.coverUrl));
    return;
  }

  for (const it of valid) {
    const entry = { key: Math.random(), title: it.title, coverUrl: it.coverUrl, progress: 0 };
    state.uploads.push(entry);
    renderShelf();
    try {
      const book = await api.uploadBook(it, (p) => {
        entry.progress = p;
        const bar = libView?.querySelectorAll('.book.uploading')[state.uploads.indexOf(entry)];
        if (bar) {
          bar.querySelector('.upload-bar > div').style.width = `${Math.round(p * 100)}%`;
          bar.querySelector('.book-sub').textContent = `Uploading… ${Math.round(p * 100)}%`;
        }
      });
      state.books.unshift(book);
      saveBooksLocal();
    } catch (e) {
      toast(`“${it.title}”: ${e.message}`);
    } finally {
      state.uploads = state.uploads.filter((u) => u !== entry);
      if (it.coverUrl) setTimeout(() => URL.revokeObjectURL(it.coverUrl), 5000);
      renderShelf();
    }
  }
}

// ------------------------------------------------------------------ account
function accountSheet() {
  const u = state.user;
  return sheet(
    `<h3>${esc(u.name)}</h3><p class="sub">${esc(u.email)} · ${state.books.length} book${state.books.length === 1 ? '' : 's'} in your library</p>
     <div class="menu">
       <button data-a="name">Change Name</button>
       <button data-a="password">Change Password</button>
       <button data-a="install" hidden>Install Bindr App</button>
       <button data-a="logout">Sign Out</button>
       <button data-a="delete" class="danger">Delete Account</button>
       <button data-a="cancel">Close</button>
     </div>`,
    (el, close) => {
      if (deferredInstall) el.querySelector('[data-a="install"]').hidden = false;
      el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
        close();
        const a = b.dataset.a;
        if (a === 'logout') signOut();
        if (a === 'name') changeName();
        if (a === 'password') changePassword();
        if (a === 'delete') deleteAccount();
        if (a === 'install' && deferredInstall) { deferredInstall.prompt(); deferredInstall = null; }
      }));
    },
  );
}

function formSheet(title, fieldsHtml, submitLabel, onSubmit, danger = false) {
  return sheet(
    `<h3>${esc(title)}</h3><form>${fieldsHtml}<p class="form-error"></p>
     <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}">${esc(submitLabel)}</button></div></form>`,
    (el, close) => {
      const form = el.querySelector('form');
      el.querySelector('[data-cancel]').onclick = () => close();
      form.onsubmit = async (e) => {
        e.preventDefault();
        try { await onSubmit(form); close(); } catch (ex) { el.querySelector('.form-error').textContent = ex.message; }
      };
    },
  );
}

function changeName() {
  formSheet('Change Name',
    `<label class="field"><span>Name</span><input name="name" maxlength="80" value="${esc(state.user.name)}" autofocus required></label>`,
    'Save', async (f) => {
      state.user = (await api.updateMe({ name: f.name.value.trim() })).user;
      localStorage.setItem('bindr:user', JSON.stringify(state.user));
      showLibrary();
    });
}

function changePassword() {
  formSheet('Change Password',
    `<label class="field"><span>Current password</span><input name="cur" type="password" autocomplete="current-password" autofocus required></label>
     <label class="field"><span>New password</span><input name="next" type="password" autocomplete="new-password" minlength="8" required></label>`,
    'Update', async (f) => {
      await api.updateMe({ currentPassword: f.cur.value, newPassword: f.next.value });
      toast('Password updated. Other devices were signed out.');
    });
}

function deleteAccount() {
  formSheet('Delete Account',
    `<p class="sub">This permanently deletes your account and every book in your library. Enter your password to confirm.</p>
     <label class="field"><span>Password</span><input name="pw" type="password" autocomplete="current-password" autofocus required></label>`,
    'Delete Everything', async (f) => {
      await api.deleteAccount(f.pw.value);
      await signOut();
      toast('Your account was deleted.');
    }, true);
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

// ------------------------------------------------------------------ reader
let progressTimer = null;
let pendingProgress = null;

function flushProgress() {
  clearTimeout(progressTimer);
  if (!pendingProgress) return;
  const { id, currentPage, pageCount } = pendingProgress;
  pendingProgress = null;
  api.updateBook(id, { currentPage, pageCount })
    .then(({ book }) => { replaceBook(book); })
    .catch(() => {
      // Offline: remember locally and retry next time we're online.
      const q = JSON.parse(localStorage.getItem('bindr:pending') || '{}');
      q[id] = { currentPage, pageCount };
      localStorage.setItem('bindr:pending', JSON.stringify(q));
    });
}

async function syncPending() {
  const q = JSON.parse(localStorage.getItem('bindr:pending') || '{}');
  for (const [id, fields] of Object.entries(q)) {
    try {
      replaceBook((await api.updateBook(id, fields)).book);
      delete q[id];
    } catch (e) {
      if (e.status === 404) delete q[id];
      else break;
    }
  }
  localStorage.setItem('bindr:pending', JSON.stringify(q));
}
window.addEventListener('online', syncPending);
syncPending();

function showReader(book) {
  closeReader();
  document.title = `${book.title} · Bindr`;
  const view = tpl('tpl-reader');
  app.replaceChildren(view);
  libView = null;

  const pending = JSON.parse(localStorage.getItem('bindr:pending') || '{}')[book.id];
  const start = pending?.currentPage || book.currentPage || 1;

  const reader = new Reader(view, book, {
    onClose: () => {
      if (pushedReader) { pushedReader = false; history.back(); }
      else { history.replaceState(null, '', '/'); route(); }
    },
    onProgress: (page, pageCount) => {
      const local = state.books.find((b) => b.id === book.id);
      if (local) Object.assign(local, { currentPage: page, pageCount, lastOpenedAt: Date.now() });
      saveBooksLocal();
      pendingProgress = { id: book.id, currentPage: page, pageCount };
      clearTimeout(progressTimer);
      progressTimer = setTimeout(flushProgress, 800);
    },
  });
  state.reader = reader;
  // Mark as opened right away so it shows under "Continue Reading".
  reader.onProgress(start, book.pageCount);
  reader.open(start).catch((e) => {
    console.error(e);
    if (state.reader !== reader) return;
    view.querySelector('.reader-loading').innerHTML = `<p>${esc(e.message || 'Could not open this book.')}</p>
      <button class="btn primary">Back to Library</button>`;
    view.querySelector('.reader-loading button').onclick = () => navigate('/');
  });
}

function closeReader() {
  if (!state.reader) return;
  flushProgress();
  state.reader.destroy();
  state.reader = null;
}

document.addEventListener('visibilitychange', () => { if (document.hidden) flushProgress(); });
window.addEventListener('pagehide', flushProgress);
