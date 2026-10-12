import { api } from './api.js';
import { inspectPdf } from './pdf.js';
import { Reader } from './reader.js';
import { esc, sheet, menu, confirmSheet, toast } from './ui.js';
import { starsHtml, fmtRating, reviewSheet, publishSheet, publishFieldsHtml, readPublishFields } from './social.js';

const app = document.getElementById('app');
const tpl = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

const state = {
  user: null,
  books: [],
  query: '',
  sort: localStorage.getItem('bindr:sort') || 'recent',
  uploads: [], // in-flight uploads: {key, title, author, coverUrl, progress}
  storeQuery: '',
  storeSort: localStorage.getItem('bindr:store-sort') || 'new',
  storeItems: null,
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
  if (location.pathname === '/store') return showStore();
  showLibrary();
}

/** Library / Book Store tabs and the account button, shared by both views. */
function bindHeader(view) {
  const avatar = view.querySelector('.avatar');
  avatar.textContent = (state.user.name || state.user.email || '?').trim()[0].toUpperCase();
  avatar.onclick = accountSheet;
  view.querySelectorAll('.tab').forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }));
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
  storeView = null;
  app.replaceChildren(libView);
  bindHeader(libView);

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
          ${b.rating || b.published ? `<div class="book-meta">${b.rating ? `${starsHtml(b.rating, 11)}<span>${fmtRating(b.rating)}</span>` : ''}${b.published ? '<span class="pub-badge" title="Public in the Book Store">Public</span>' : ''}</div>` : ''}
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
    { label: `Book Store: ${book.published ? 'Public' : book.storeId ? 'From the Book Store' : 'Private'}…`, value: 'publish' },
    { label: 'Rename / Edit Details', value: 'rename' },
    { label: 'Mark as Unread', value: 'reset' },
    { label: 'Remove from Library', value: 'delete', danger: true },
  ]);
  if (choice === 'read') navigate(`/read/${book.id}`);
  if (choice === 'rename') renameBook(book);
  if (choice === 'rate') rateBook(book);
  if (choice === 'publish') {
    const updated = await publishSheet(book, state.user);
    if (updated) { replaceBook(updated); renderShelf(); }
  }
  if (choice === 'reset') {
    try {
      replaceBook((await api.updateBook(book.id, { reset: true })).book);
      renderShelf();
    } catch (e) { toast(e.message); }
  }
  if (choice === 'delete') {
    const ok = await confirmSheet('Remove this book?', `“${book.title}” will be deleted from your cloud library on all devices.${book.published ? ' It will also be removed from the Book Store.' : ''}`, 'Remove');
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

// ------------------------------------------------------------------ book store
let storeView = null;
let storeTimer = null;

function showStore() {
  closeReader();
  if (!state.user) return showAuth();
  document.title = 'Book Store · Bindr';
  libView = null;
  storeView = tpl('tpl-store');
  app.replaceChildren(storeView);
  bindHeader(storeView);
  const search = storeView.querySelector('.search input');
  search.value = state.storeQuery;
  search.oninput = () => {
    state.storeQuery = search.value;
    clearTimeout(storeTimer);
    storeTimer = setTimeout(loadStore, 250);
  };
  const sort = storeView.querySelector('.sort');
  sort.value = state.storeSort;
  sort.onchange = () => { state.storeSort = sort.value; localStorage.setItem('bindr:store-sort', sort.value); loadStore(); };
  if (state.storeItems) renderStore();
  loadStore();
}

async function loadStore() {
  const view = storeView;
  try {
    const { items } = await api.store(state.storeQuery.trim(), state.storeSort);
    if (view !== storeView) return;
    state.storeItems = items;
    renderStore();
  } catch (e) {
    if (view !== storeView) return;
    state.storeItems = state.storeItems || [];
    renderStore(e.offline ? 'The Book Store needs an internet connection.' : e.message);
  }
}

function storeCoverHtml(item) {
  const img = item.hasCover ? `<img src="${api.storeCoverUrl(item)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="cover"><div class="placeholder">${esc(item.title)}</div>${img}</div>`;
}

function ratingLine(item) {
  return item.reviewCount
    ? `${starsHtml(item.rating, 12)}<span>${fmtRating(item.rating)} (${item.reviewCount})</span>`
    : '<span class="muted">No ratings yet</span>';
}

function renderStore(error) {
  if (!storeView) return;
  const items = state.storeItems || [];
  const searching = !!state.storeQuery.trim();
  const grid = storeView.querySelector('.grid');
  grid.innerHTML = items.map((it) => `
    <div class="book" data-id="${esc(it.id)}">
      <button class="book-open" aria-label="${esc(it.title)}">${storeCoverHtml(it)}</button>
      <div class="book-info"><div class="book-text">
        <div class="book-title" title="${esc(it.title)}">${esc(it.title)}</div>
        <div class="book-sub">${esc(it.author || 'Unknown writer')}</div>
        <div class="book-meta">${ratingLine(it)}</div>
        ${it.mine ? '<div class="book-sub"><span class="pub-badge">Yours</span></div>' : it.libraryBookId ? '<div class="book-sub"><span class="new">IN LIBRARY</span></div>' : ''}
      </div></div>
    </div>`).join('');
  grid.querySelectorAll('.book').forEach((el) => {
    el.querySelector('.book-open').onclick = () => storeDetail(el.dataset.id);
  });
  const empty = storeView.querySelector('.empty');
  empty.hidden = items.length > 0;
  storeView.querySelector('.empty-title').textContent = error ? 'Couldn’t load the Book Store'
    : searching ? 'No matches' : 'No public books yet';
  storeView.querySelector('.empty-text').textContent = error
    || (searching ? 'Try a different title, writer or publisher.' : 'Make one of your books Public from its ••• menu to share it here.');
  storeView.querySelector('.shelf-title').textContent = searching ? `Results (${items.length})` : 'Public Books';
}

async function storeDetail(id) {
  let data;
  try {
    data = await api.storeItem(id);
  } catch (e) {
    toast(e.message);
    if (e.status === 404) loadStore();
    return;
  }
  const { item, reviews } = data;
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const action = await sheet(
    `<div class="store-detail">
       ${storeCoverHtml(item)}
       <div class="store-meta">
         <h3>${esc(item.title)}</h3>
         <div class="by">${esc(item.author || 'Unknown writer')}</div>
         <div class="sub">Published by <b>${esc(item.publisher)}</b></div>
         <div class="book-meta big">${ratingLine(item)}</div>
         <div class="sub">${item.pageCount ? `${item.pageCount} pages · ` : ''}${(item.size / 1048576).toFixed(1)} MB · ${item.downloads} reader${item.downloads === 1 ? '' : 's'}</div>
       </div>
     </div>
     <div class="actions">
       ${item.libraryBookId ? '<button class="btn primary" data-a="read">Read</button>' : '<button class="btn primary" data-a="add">Add to Library</button>'}
       <button class="btn" data-a="rate">Rate & Review</button>
       ${item.mine ? '<button class="btn" data-a="manage">Manage</button>' : ''}
     </div>
     <h4 class="reviews-title">Reviews</h4>
     <div class="reviews">${reviews.length ? reviews.map((r) => `
       <div class="review">
         <div class="review-head">${starsHtml(r.rating, 13)}<b>${fmtRating(r.rating)}</b>${r.title ? `<span class="review-title">${esc(r.title)}</span>` : ''}</div>
         ${r.body ? `<p>${esc(r.body).replace(/\n/g, '<br>')}</p>` : ''}
         <div class="review-by">${esc(r.author)}${r.isPublisher ? ' · Publisher' : ''}${r.mine ? ' · You' : ''} · ${fmtDate(r.updatedAt)}</div>
       </div>`).join('') : '<p class="muted">No reviews yet. Add the book and be the first to review it.</p>'}</div>`,
    (el, close) => el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => close(b.dataset.a))),
  );
  if (!action) return;
  if (action === 'read') return navigate(`/read/${item.libraryBookId}`);
  let book = state.books.find((b) => b.id === item.libraryBookId);
  if (action === 'manage' && book) {
    const updated = await publishSheet(book, state.user);
    if (updated) replaceBook(updated);
    return loadStore();
  }
  if (!book) {
    try {
      book = (await api.addFromStore(item.id)).book;
      replaceBook(book);
      if (action === 'add') toast(`“${item.title}” was added to your library.`);
    } catch (e) {
      return toast(e.message);
    }
  }
  if (action === 'rate') {
    const updated = await reviewSheet(book);
    if (updated) replaceBook(updated);
  }
  await loadStore();
  storeDetail(item.id);
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
           <div class="field"><span>Book Store</span>
             <div class="seg vis-seg" data-i="${i}">
               <button type="button" class="seg-btn active" data-vis="private">Private</button>
               <button type="button" class="seg-btn" data-vis="public">Public</button>
             </div>
           </div>
           <div class="pub-fields" data-i="${i}" hidden>
             ${publishFieldsHtml(`p${i}-`, { title: it.title, author: it.author, publisher: state.user.name })}
           </div>
         </div>
       </div>`).join('')}
       <p class="form-error"></p>
       <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Add to Library</button></div>
     </form>`,
    (el, close) => {
      const form = el.querySelector('form');
      el.querySelector('[data-cancel]').onclick = () => close(false);
      const isPublic = valid.map(() => false);
      el.querySelectorAll('.vis-seg').forEach((seg) => {
        const i = +seg.dataset.i;
        seg.querySelectorAll('[data-vis]').forEach((b) => (b.onclick = () => {
          isPublic[i] = b.dataset.vis === 'public';
          seg.querySelectorAll('[data-vis]').forEach((x) => x.classList.toggle('active', x === b));
          el.querySelector(`.pub-fields[data-i="${i}"]`).hidden = !isPublic[i];
        }));
        // Keep the store name/writer in step with the library ones until edited separately.
        for (const f of ['title', 'author']) {
          const src = form[`${f}-${i}`];
          const dst = form[`p${i}-${f}`];
          dst.addEventListener('input', () => { dst.dataset.edited = '1'; });
          src.addEventListener('input', () => { if (!dst.dataset.edited) dst.value = src.value; });
        }
      });
      form.onsubmit = (e) => {
        e.preventDefault();
        const err = el.querySelector('.form-error');
        for (let i = 0; i < valid.length; i++) {
          if (!isPublic[i]) continue;
          const f = readPublishFields(form, `p${i}-`);
          if (!f.title || !f.publisher) { err.textContent = 'Public books need a Book Store name and a publisher name.'; return; }
          if (!f.confirm) { err.textContent = 'Confirm you have the right to share each public book.'; return; }
        }
        valid.forEach((it, i) => {
          it.title = form[`title-${i}`].value.trim() || it.title;
          it.author = form[`author-${i}`].value.trim();
          it.publish = isPublic[i] ? readPublishFields(form, `p${i}-`) : null;
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
      if (it.publish) {
        try {
          replaceBook((await api.publish(book.id, it.publish)).book);
          toast(`“${it.publish.title}” is now in the Book Store.`);
        } catch (e) {
          toast(`Uploaded, but publishing failed: ${e.message}`);
        }
      }
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
  storeView = null;

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
