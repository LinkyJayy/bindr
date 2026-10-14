import { api, onNeedsVerification } from './api.js';
import { inspectPdf } from './pdf.js';
import { FilterPanel, applyAppFilter, PRESETS, COLORBLIND, loadSetting, saveSetting, isEink } from './filters.js';
import { Reader } from './reader.js';
import { esc, sheet, menu, confirmSheet, toast } from './ui.js';
import { renderMarkdown } from './md.js';
import { starsHtml, fmtRating, reviewSheet } from './social.js';

const app = document.getElementById('app');
const tpl = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

const state = {
  user: null,
  books: [],
  query: '',
  sort: localStorage.getItem('bindr:sort') || 'recent',
  uploads: [], // in-flight uploads: {key, title, author, coverUrl, progress}
  view: null, // 'home' | 'library' | 'settings' | 'reviews'
  libFilter: localStorage.getItem('bindr:lib-filter') || 'all',
  libLayout: localStorage.getItem('bindr:lib-layout') || 'grid',
  reader: null,
};

// ------------------------------------------------------------------ boot
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

applyAppFilter(); // the color filter applies to the whole app
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
  if (state.user.mustVerify) return showVerify();
  await loadBooks();
  route();
}

// The server asks for a verified email (e.g. verification was switched on after sign-in).
onNeedsVerification(() => {
  if (!state.user || document.querySelector('.verify-card')) return;
  state.user.mustVerify = true;
  showVerify();
});

/** Saves the signed-in account and opens the app (or the verify screen first). */
async function signedIn(user, { delivery = null, recoveryKey = null, keyIntro } = {}) {
  state.user = user;
  localStorage.setItem('bindr:user', JSON.stringify(user));
  if (recoveryKey) return showRecoveryKey(recoveryKey, () => signedIn(user, { delivery }), { intro: keyIntro });
  if (user.mustVerify) return showVerify({ delivery });
  // The owner's account gets a code even when verification is optional.
  if (delivery && !user.verified) return showVerify({ delivery, optional: true });
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
  const views = { '/': 'home', '/library': 'library', '/settings': 'settings', '/reviews': 'reviews', '/about': 'about' };
  if (!views[location.pathname]) history.replaceState(null, '', '/');
  showShell(views[location.pathname] || 'home');
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
    view.querySelector('.only-login').hidden = m !== 'login';
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    form.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    err.textContent = '';
  };
  view.querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  view.querySelector('[data-action="forgot"]').onclick = () => showReset(form.email.value.trim());
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const { email, password, name } = form;
      const { user, delivery, recoveryKey } = mode === 'login'
        ? await api.login(email.value.trim(), password.value)
        : await api.register(name.value.trim(), email.value.trim(), password.value);
      await signedIn(user, { delivery, recoveryKey });
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  };
}

/** A centered card like the sign-in screen. */
function authCard(html) {
  closeReader();
  const main = document.createElement('main');
  main.className = 'auth';
  main.innerHTML = `<div class="auth-card">
    <img class="auth-logo" src="/icons/icon-192.png" alt="" width="72" height="72">${html}</div>`;
  app.replaceChildren(main);
  document.title = 'Bindr';
  return main;
}

const LOGGED_NOTE = 'This server has no email service set up, so the code was written to the server log instead of being emailed.';

/** Asks for a 6-digit code to sign up or to verify an existing account. */
function showVerify({ delivery = null, optional = false } = {}) {
  const view = authCard(`<h1>Verify your email</h1>
    <p class="auth-text">Enter the 6-digit code we sent to <strong>${esc(state.user.email)}</strong>.</p>
    <p class="auth-note" hidden></p>
    <form class="auth-form verify-card" novalidate>
      <label class="field"><span>Code</span>
        <input name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required placeholder="000000"></label>
      <p class="form-error" role="alert"></p>
      <button class="btn primary block" type="submit">Verify</button>
      <button class="auth-link" type="button" data-action="resend">Send a new code</button>
      <button class="auth-link" type="button" data-action="leave">${optional ? 'Not now' : 'Sign out'}</button>
    </form>`);
  const form = view.querySelector('form');
  const err = view.querySelector('.form-error');
  const note = view.querySelector('.auth-note');
  const resend = view.querySelector('[data-action="resend"]');
  const showDelivery = (d) => { note.hidden = d !== 'logged'; note.textContent = LOGGED_NOTE; };
  let wait = null;
  const cooldown = (secs) => {
    clearInterval(wait);
    let left = secs;
    const tick = () => {
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `Send a new code (${left}s)` : 'Send a new code';
      if (left-- <= 0) clearInterval(wait);
    };
    tick();
    wait = setInterval(tick, 1000);
  };
  const send = async ({ quiet = false } = {}) => {
    err.textContent = '';
    try {
      showDelivery((await api.sendVerification()).delivery);
      if (!quiet) toast('A new code is on its way.');
      cooldown(60);
    } catch (ex) {
      const secs = ex.status === 429 && +(ex.message.match(/(\d+) seconds/) || [])[1];
      if (secs) cooldown(secs);
      if (!(quiet && ex.status === 429)) err.textContent = ex.message;
    }
  };
  resend.onclick = () => send();
  view.querySelector('[data-action="leave"]').onclick = async () => {
    clearInterval(wait);
    if (!optional) return signOut();
    await loadBooks();
    route();
  };
  form.code.oninput = () => {
    form.code.value = form.code.value.replace(/\D/g, '').slice(0, 6);
    if (form.code.value.length === 6) form.requestSubmit();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    if (submit.disabled) return;
    err.textContent = '';
    submit.disabled = true;
    try {
      const { user } = await api.verifyEmail(form.code.value);
      clearInterval(wait);
      toast('Email verified.');
      await signedIn(user);
    } catch (ex) {
      err.textContent = ex.message;
      form.code.select();
    } finally {
      submit.disabled = false;
    }
  };
  // A code was just sent by signing up; otherwise send one now.
  if (delivery) { showDelivery(delivery); cooldown(60); } else send({ quiet: true });
  form.code.focus();
}

/** Forgot password: with the recovery key, or with a code sent to the email address. */
function showReset(prefill = '', mode = 'key') {
  const byKey = mode === 'key';
  const view = authCard(`<h1>Reset password</h1>
    <p class="auth-text">${byKey
      ? 'Enter your email and the recovery key you saved when you created your account.'
      : 'We’ll send a code to your email to choose a new password.'}</p>
    <p class="auth-note" hidden></p>
    <form class="auth-form" novalidate>
      <label class="field"><span>Email</span>
        <input name="email" type="email" autocomplete="email" required placeholder="you@example.com" value="${esc(prefill)}"></label>
      ${byKey ? `<label class="field"><span>Recovery key</span>
        <input name="key" class="key-input" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX"></label>` : ''}
      <div class="reset-step2" ${byKey ? '' : 'hidden'}>
        ${byKey ? '' : `<label class="field"><span>Code</span>
          <input name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>`}
        <label class="field"><span>New password</span>
          <input name="password" type="password" autocomplete="new-password" minlength="8" placeholder="At least 8 characters"></label>
      </div>
      <p class="form-error" role="alert"></p>
      <button class="btn primary block" type="submit">${byKey ? 'Reset Password' : 'Email me a code'}</button>
      <button class="auth-link" type="button" data-action="resend" hidden>Send a new code</button>
      <button class="auth-link" type="button" data-action="switch">${byKey ? 'Lost your key? Use an email code' : 'Use my recovery key instead'}</button>
      <button class="auth-link" type="button" data-action="back">Back to sign in</button>
    </form>`);
  const form = view.querySelector('form');
  const err = view.querySelector('.form-error');
  const submit = form.querySelector('[type="submit"]');
  const text = view.querySelector('.auth-text');
  const note = view.querySelector('.auth-note');
  const resend = view.querySelector('[data-action="resend"]');
  let step = 1;
  const send = async () => {
    const { delivery } = await api.sendReset(form.email.value.trim());
    note.hidden = delivery !== 'logged';
    note.textContent = LOGGED_NOTE;
    step = 2;
    form.email.readOnly = true;
    view.querySelector('.reset-step2').hidden = false;
    resend.hidden = false;
    text.innerHTML = `If there's an account for <strong>${esc(form.email.value.trim())}</strong>, we've emailed it a 6-digit code. Enter it with your new password.`;
    submit.textContent = 'Set New Password';
    form.code.focus();
  };
  resend.onclick = async () => {
    err.textContent = '';
    try { await send(); toast('A new code is on its way.'); } catch (ex) { err.textContent = ex.message; }
  };
  view.querySelector('[data-action="switch"]').onclick = () => showReset(form.email.value.trim(), byKey ? 'email' : 'key');
  view.querySelector('[data-action="back"]').onclick = () => showAuth();
  if (form.code) form.code.oninput = () => { form.code.value = form.code.value.replace(/\D/g, '').slice(0, 6); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      if (!byKey && step === 1) await send();
      else {
        const email = form.email.value.trim();
        const { user, recoveryKey } = byKey
          ? await api.recover(email, form.key.value, form.password.value)
          : await api.resetPassword(email, form.code.value, form.password.value);
        toast('Password changed. Other devices were signed out.');
        await signedIn(user, { recoveryKey, keyIntro: 'Your old recovery key no longer works. Save this new one in place of it.' });
      }
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  };
  form.email.focus();
}

/** Shows a new recovery key once; the person must confirm they saved it. */
function showRecoveryKey(key, onDone, { intro } = {}) {
  const view = authCard(`<h1>Save your recovery key</h1>
    <p class="auth-text">${esc(intro || 'If you ever forget your password, this key lets you choose a new one.')}
      Keep it somewhere safe, like a password manager or a note on paper. You won't see it again.</p>
    <div class="recovery-key" aria-label="Recovery key">${esc(key)}</div>
    <div class="recovery-actions">
      <button class="btn" type="button" data-action="copy">Copy</button>
      <button class="btn" type="button" data-action="download">Download</button>
    </div>
    <label class="check-row"><input type="checkbox" name="saved"> I've saved my recovery key</label>
    <button class="btn primary block" type="button" data-action="done" disabled>Continue</button>`);
  const done = view.querySelector('[data-action="done"]');
  view.querySelector('[name="saved"]').onchange = (e) => { done.disabled = !e.target.checked; };
  view.querySelector('[data-action="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(key); toast('Recovery key copied.'); } catch { toast('Couldn’t copy. Select the key and copy it yourself.'); }
  };
  view.querySelector('[data-action="download"]').onclick = () => {
    const blob = new Blob([`Bindr recovery key for ${state.user?.email || 'your account'}\n\n${key}\n\nUse it under "Forgot password?" on the Bindr sign-in screen.\n`], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'bindr-recovery-key.txt' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  done.onclick = () => onDone();
}

/** Settings: make a new recovery key (needs the password). */
function createRecoveryKey() {
  const had = state.user.hasRecoveryKey;
  formSheet(had ? 'New Recovery Key' : 'Set Up Recovery Key',
    `<p class="sub">${had ? 'Your current recovery key will stop working. ' : ''}Enter your password to continue.</p>
     <label class="field"><span>Password</span><input name="pw" type="password" autocomplete="current-password" autofocus required></label>`,
    'Continue', async (f) => {
      const { user, recoveryKey } = await api.newRecoveryKey(f.pw.value);
      state.user = user;
      localStorage.setItem('bindr:user', JSON.stringify(user));
      setTimeout(() => showRecoveryKey(recoveryKey, () => route()));
    });
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

// ------------------------------------------------------------------ app theme (UI dark mode)
function uiTheme() {
  return document.documentElement.dataset.ui || 'auto';
}

function uiIsDark() {
  const t = uiTheme();
  return t === 'auto' ? matchMedia('(prefers-color-scheme: dark)').matches : t === 'dark';
}

function setUiTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.ui;
  else document.documentElement.dataset.ui = t;
  try {
    if (t === 'auto') localStorage.removeItem('bindr:ui-theme');
    else localStorage.setItem('bindr:ui-theme', t);
  } catch {}
  applyAppFilter(); // the filtered page background depends on the theme
  syncQuick();
}

/** One-tap E-ink look (remembers the filter you had before). */
function toggleEink() {
  const cur = loadSetting();
  if (isEink(cur)) {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem('bindr:filter-before-eink') || 'null'); } catch {}
    saveSetting(prev && !isEink(prev) ? prev : { ...cur, preset: 'none' });
  } else {
    try { localStorage.setItem('bindr:filter-before-eink', JSON.stringify(cur)); } catch {}
    saveSetting({ ...cur, preset: 'eink' });
  }
  applyAppFilter();
  syncQuick();
  if (state.view === 'settings') renderShelf();
}

const THEME_LABEL = { auto: 'Automatic', light: 'Off', dark: 'On' };
const TURN_LABEL = { curl: 'Curl', slide: 'Slide', instant: 'Instant' };

function filterLabel() {
  const s = loadSetting();
  if (s.preset === 'colorblind') return COLORBLIND.find((c) => c.id === s.colorblind)?.label || 'Colorblind';
  if (s.preset === 'eink' && s.einkType === 'colorsoft') return 'E-ink (Colorsoft)';
  return PRESETS.find((p) => p.id === s.preset)?.label || 'Original';
}

/** The color filter, for the whole app. */
function filterSheet() {
  return sheet(
    `<h3>Color Filter</h3><p class="sub">Applies to the whole app and every book. Highlights keep their colors in Grayscale and Achromatopsia.</p>
     <div class="fp-embed"></div>
     <div class="actions"><button class="btn primary" data-close>Done</button></div>`,
    (el, close) => {
      new FilterPanel(el.querySelector('.fp-embed'), el.querySelector('[data-close]'), () => applyAppFilter(loadSetting()), { embedded: true });
      el.querySelector('[data-close]').onclick = () => close();
    },
  ).then(() => renderShelf());
}
const LAYOUT_LABEL = { auto: 'Automatic', single: 'One page', double: 'Two pages' };

// ------------------------------------------------------------------ shell (top bar + bottom nav)
let shell = null;

const ICONS = {
  more: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="5.5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="18.5" r="1.8" fill="currentColor"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  grid: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
  book: '<svg class="empty-icon" viewBox="0 0 24 24"><path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5zM12 6.5v13" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/></svg>',
};

const VIEW_TITLES = { home: 'Home', library: 'Library', settings: 'Settings', reviews: 'Ratings & Reviews', about: 'About' };

function showShell(view) {
  closeReader();
  if (!state.user) return showAuth();
  const changed = state.view !== view || !shell || !app.contains(shell);
  state.view = view;
  if (!shell || !app.contains(shell)) {
    shell = tpl('tpl-shell');
    app.replaceChildren(shell);
    bindShell();
  }
  shell.querySelectorAll('[data-nav]').forEach((b) => {
    const on = b.dataset.nav === (view === 'home' ? '/' : `/${view}`);
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.title = `${VIEW_TITLES[view]} · Bindr`;
  if (view === 'about' && changed && !about.editing) about.loaded = false;
  renderShelf();
  updateCurrentNav();
  if (changed) window.scrollTo(0, 0);
}

function bindShell() {
  updateClock();
  const fileInput = shell.querySelector('.file-input');
  const pickFiles = () => fileInput.click();
  fileInput.onchange = () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) startUpload(files);
  };
  shell.querySelector('[data-action="upload"]').onclick = pickFiles;
  shell.querySelector('[data-action="more"]').onclick = moreMenu;

  const search = shell.querySelector('.k-search input');
  search.value = state.query;
  search.oninput = () => {
    state.query = search.value;
    renderShelf();
  };

  // Quick settings, dropped down from the clock like on an e-reader.
  const quickBtn = shell.querySelector('[data-action="quick"]');
  const panel = shell.querySelector('.k-quick-panel');
  const scrim = shell.querySelector('.k-quick-scrim');
  const setQuick = (open) => {
    panel.hidden = !open;
    scrim.hidden = !open;
    quickBtn.setAttribute('aria-expanded', String(open));
    if (open) syncQuick();
  };
  quickBtn.onclick = () => setQuick(panel.hidden);
  scrim.onclick = () => setQuick(false);
  shell.querySelector('[data-action="quick-close"]').onclick = () => setQuick(false);
  shell.querySelectorAll('[data-quick]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.quick;
    if (a === 'theme') { setUiTheme(uiIsDark() ? 'light' : 'dark'); return; }
    if (a === 'eink') { toggleEink(); return; }
    setQuick(false);
    if (a === 'sync') syncLibrary();
    if (a === 'upload') pickFiles();
    if (a === 'settings') navigate('/settings');
  }));

  shell.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => {
    if (state.query) { state.query = ''; search.value = ''; }
    navigate(b.dataset.nav);
  }));

  // Drag & drop PDFs anywhere.
  const overlay = shell.querySelector('.drop-overlay');
  let depth = 0;
  shell.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; overlay.hidden = false; } });
  shell.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  shell.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  shell.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) startUpload(files);
  });
}

/** The book you read last, between Home and Library in the bottom bar. */
function updateCurrentNav() {
  if (!shell) return;
  const btn = shell.querySelector('[data-current]');
  const last = state.books.filter((b) => b.lastOpenedAt).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  btn.hidden = !last;
  if (!last) return;
  btn.setAttribute('aria-label', `Continue reading ${last.title}`);
  btn.title = last.title;
  btn.querySelector('.k-current-cover').innerHTML = last.hasCover
    ? `<img src="${api.coverUrl(last)}" alt="" onerror="this.remove()">` : '';
  const pct = progressPct(last);
  btn.querySelector('.k-current-title').textContent = pct === null ? last.title : `${last.title} · ${pct}%`;
  btn.onclick = () => navigate(`/read/${last.id}`);
}

function syncQuick() {
  if (!shell) return;
  const e = shell.querySelector('[data-quick="eink"]');
  const einkOn = isEink(loadSetting());
  e.classList.toggle('on', einkOn);
  e.querySelector('small').textContent = einkOn ? 'On' : 'Off';
  const b = shell.querySelector('[data-quick="theme"]');
  b.classList.toggle('on', uiIsDark());
  b.querySelector('small').textContent = uiIsDark() ? 'On' : 'Off';
}

function updateClock() {
  if (!shell || !app.contains(shell)) return;
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  shell.querySelectorAll('.k-clock').forEach((el) => { el.textContent = time; });
}
setInterval(updateClock, 15000);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncQuick);

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

async function syncLibrary() {
  await syncPending();
  await loadBooks();
  renderShelf();
  toast('Your library is up to date.');
}

async function moreMenu() {
  const choice = await menu('', [
    { label: 'Sync Your Library', value: 'sync' },
    { label: 'Add Books', value: 'upload' },
    { label: 'Ratings & Reviews', value: 'reviews' },
    { label: 'Settings', value: 'settings' },
    { label: 'Help', value: 'help' },
    { label: 'About', value: 'about' },
  ]);
  if (choice === 'sync') syncLibrary();
  if (choice === 'upload') shell.querySelector('.file-input').click();
  if (choice === 'reviews') navigate('/reviews');
  if (choice === 'settings') navigate('/settings');
  if (choice === 'help') helpSheet();
  if (choice === 'about') navigate('/about');
}

function helpSheet() {
  return sheet(
    `<h3>Using Bindr</h3>
     <ul class="help-list">
       <li><b>Add books:</b> tap <b>+</b> at the top, or drop PDF or ePUB files onto the window.</li>
       <li><b>Highlight:</b> press and hold a word, drag to select more, then pick a color.</li>
       <li><b>Dictionary:</b> double-tap a word.</li>
       <li><b>Chapters:</b> ⋮ → Chapters while reading. Add your own if the book has none. Tap the page count at the bottom right to switch between chapter and book.</li>
       <li><b>Rate a book:</b> double-tap or press and hold its cover.</li>
       <li><b>More options:</b> the <b>⋮</b> next to a book.</li>
       <li><b>Turn pages:</b> swipe, tap the edges, or use the arrow keys.</li>
       <li><b>Zoom:</b> double-tap empty space on a page.</li>
       <li><b>Dark pages, font size, layout, page turn and color:</b> the <b>Aa</b> button while reading. Dark pages are set per book.</li>
       <li><b>Listen:</b> the microphone while reading.</li>
     </ul>
     <div class="actions"><button class="btn primary" data-ok>Done</button></div>`,
    (el, close) => { el.querySelector('[data-ok]').onclick = () => close(); },
  );
}

// ------------------------------------------------------------------ about page
// Everyone can read it; the owner's account (checked by the server) can edit it in Markdown.
const about = { loaded: false, loading: false, content: '', updatedAt: null, canEdit: false, editing: false, draft: '', tab: 'write' };

async function loadAbout() {
  if (about.loading) return;
  about.loading = true;
  try {
    Object.assign(about, await api.about(), { loaded: true, error: null });
    localStorage.setItem('bindr:about', JSON.stringify({ content: about.content, updatedAt: about.updatedAt }));
  } catch (e) {
    const cached = JSON.parse(localStorage.getItem('bindr:about') || 'null');
    if (cached) Object.assign(about, cached, { loaded: true, canEdit: false, verifyToEdit: false });
    about.error = e.offline ? 'You’re offline. Showing the last version you saw.' : e.message;
  } finally {
    about.loading = false;
    if (state.view === 'about' && !about.editing) renderShelf();
  }
}

const ABOUT_PLACEHOLDER = '*Nothing here yet.*';
const MD_TOOLS = [
  { id: 'h', label: 'H', title: 'Heading', before: '## ', after: '', line: true },
  { id: 'b', label: '<b>B</b>', title: 'Bold', before: '**', after: '**' },
  { id: 'i', label: '<i>I</i>', title: 'Italic', before: '*', after: '*' },
  { id: 'link', label: 'Link', title: 'Link', before: '[', after: '](https://)' },
  { id: 'ul', label: '• List', title: 'Bulleted list', before: '- ', after: '', line: true },
  { id: 'ol', label: '1. List', title: 'Numbered list', before: '1. ', after: '', line: true },
  { id: 'q', label: '“ Quote', title: 'Quote', before: '> ', after: '', line: true },
  { id: 'code', label: '&lt;/&gt;', title: 'Code', before: '`', after: '`' },
];

function aboutHtml() {
  if (!about.loaded) {
    loadAbout();
    return '<h1 class="k-page-title">About</h1><div class="empty"><div class="spinner" style="margin:0 auto"></div></div>';
  }
  const updated = about.updatedAt
    ? `Updated ${new Date(about.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}` : '';
  if (about.editing) {
    return `<div class="about-head"><h1 class="k-page-title">Edit About</h1></div>
      <div class="seg about-tabs" role="tablist">
        <button type="button" class="seg-btn ${about.tab === 'write' ? 'active' : ''}" data-about-tab="write">Write</button>
        <button type="button" class="seg-btn ${about.tab === 'preview' ? 'active' : ''}" data-about-tab="preview">Preview</button>
      </div>
      <div class="about-editor ${about.tab}">
        <div class="about-write">
          <div class="md-toolbar" role="toolbar" aria-label="Formatting">
            ${MD_TOOLS.map((t) => `<button type="button" data-md="${t.id}" title="${t.title}" aria-label="${t.title}">${t.label}</button>`).join('')}
          </div>
          <textarea class="about-text" spellcheck="true" aria-label="About page (Markdown)" placeholder="# About Bindr&#10;&#10;Write here using Markdown…">${esc(about.draft)}</textarea>
          <p class="hint-md">Markdown: <code># Heading</code> · <code>**bold**</code> · <code>*italic*</code> · <code>[link](https://…)</code> · <code>- list</code> · <code>&gt; quote</code> · <code>---</code></p>
        </div>
        <div class="about-preview md-body">${renderMarkdown(about.draft) || `<p class="muted">${esc('Nothing to preview yet.')}</p>`}</div>
      </div>
      <p class="form-error about-error"></p>
      <div class="about-actions">
        <button class="btn" data-about="cancel">Cancel</button>
        <button class="btn primary" data-about="save">Save</button>
      </div>`;
  }
  return `<div class="about-head">
      <h1 class="k-page-title">About</h1>
      ${about.canEdit ? '<button class="btn" data-about="edit">Edit</button>' : ''}
      ${about.verifyToEdit ? '<button class="btn" data-about="verify">Verify Email to Edit</button>' : ''}
    </div>
    ${about.error ? `<p class="book-sub" style="margin:0 0 10px">${esc(about.error)}</p>` : ''}
    <article class="md-body about-body">${renderMarkdown(about.content || ABOUT_PLACEHOLDER)}</article>
    ${updated ? `<p class="about-updated">${esc(updated)}</p>` : ''}`;
}

function bindAbout(main) {
  main.querySelector('[data-about="verify"]')?.addEventListener('click', () => {
    about.loaded = false;
    showVerify({ optional: true });
  });
  main.querySelector('[data-about="edit"]')?.addEventListener('click', () => {
    Object.assign(about, { editing: true, draft: about.content, tab: 'write' });
    renderShelf();
    main.querySelector('.about-text')?.focus();
  });
  if (!about.editing) return;
  const ta = main.querySelector('.about-text');
  const preview = main.querySelector('.about-preview');
  let t;
  ta.addEventListener('input', () => {
    about.draft = ta.value;
    clearTimeout(t);
    t = setTimeout(() => { preview.innerHTML = renderMarkdown(about.draft); }, 120); // live preview (wide screens)
  });
  main.querySelectorAll('[data-about-tab]').forEach((b) => (b.onclick = () => { about.tab = b.dataset.aboutTab; renderShelf(); }));
  main.querySelectorAll('[data-md]').forEach((b) => (b.onclick = () => {
    const tool = MD_TOOLS.find((x) => x.id === b.dataset.md);
    const { selectionStart: a, selectionEnd: z, value } = ta;
    if (tool.line) {
      // Prefix every selected line.
      const start = value.lastIndexOf('\n', a - 1) + 1;
      const block = value.slice(start, z).split('\n').map((l) => tool.before + l).join('\n');
      ta.value = value.slice(0, start) + block + value.slice(z);
      ta.setSelectionRange(start + block.length, start + block.length);
    } else {
      const sel = value.slice(a, z) || (tool.id === 'link' ? 'link text' : 'text');
      ta.value = value.slice(0, a) + tool.before + sel + tool.after + value.slice(z);
      ta.setSelectionRange(a + tool.before.length, a + tool.before.length + sel.length);
    }
    ta.focus();
    ta.dispatchEvent(new Event('input'));
  }));
  main.querySelector('[data-about="cancel"]').onclick = async () => {
    if (about.draft !== about.content && !(await confirmSheet('Discard your changes?', 'Your edits to the About page will be lost.', 'Discard'))) return;
    about.editing = false;
    renderShelf();
  };
  main.querySelector('[data-about="save"]').onclick = async (e) => {
    e.target.disabled = true;
    try {
      Object.assign(about, await api.saveAbout(about.draft), { editing: false, error: null });
      localStorage.setItem('bindr:about', JSON.stringify({ content: about.content, updatedAt: about.updatedAt }));
      renderShelf();
      toast('About page saved.');
    } catch (ex) {
      e.target.disabled = false;
      main.querySelector('.about-error').textContent = ex.message;
    }
  };
}

// ------------------------------------------------------------------ book cards
function sortBooks(list, sort) {
  const by = {
    recent: (a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
    author: (a, b) => (a.author || '￿').localeCompare(b.author || '￿') || a.title.localeCompare(b.title),
    added: (a, b) => b.createdAt - a.createdAt,
  }[sort] || (() => 0);
  return [...list].sort(by);
}

function progressPct(book) {
  if (!book.pageCount || !book.lastOpenedAt) return null;
  return Math.min(100, Math.round((book.currentPage / book.pageCount) * 100));
}

const isFinished = (b) => (progressPct(b) ?? 0) >= 100;

function coverHtml(book, { badges = false } = {}) {
  const img = book.hasCover ? `<img src="${api.coverUrl(book)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  const pct = progressPct(book);
  const extra = !badges ? '' : pct === null
    ? '<span class="badge-new">NEW</span>'
    : pct < 100 ? `<span class="cover-progress"><div style="width:${pct}%"></div></span>` : '';
  return `<div class="cover"><div class="placeholder">${esc(book.title)}</div>${img}${extra}</div>`;
}

function statusText(b) {
  const pct = progressPct(b);
  return pct === null ? 'New' : pct >= 100 ? 'Finished' : `${pct}% read`;
}

function bookCard(b, { list = false } = {}) {
  const rating = b.rating ? `<div class="book-meta">${starsHtml(b.rating, 11)}<span>${fmtRating(b.rating)}</span></div>` : '';
  return `<div class="book" data-id="${esc(b.id)}">
    <button class="book-open" aria-label="Open ${esc(b.title)}">${coverHtml(b, { badges: !list })}</button>
    <div class="book-info">
      <div class="book-text">
        <div class="book-title" title="${esc(b.title)}">${esc(b.title)}</div>
        <div class="book-sub">${list ? '' : `${statusText(b)}${b.author ? ' · ' : ''}`}${esc(b.author)}</div>
        ${rating}
      </div>
      ${list ? `<span class="k-pct">${statusText(b)}</span>` : ''}
      <button class="more" aria-label="More options for ${esc(b.title)}">${ICONS.more}</button>
    </div>
  </div>`;
}

function uploadCard(u) {
  return `<div class="book uploading">
    <div class="cover"><div class="placeholder">${esc(u.title)}</div>${u.coverUrl ? `<img src="${u.coverUrl}" alt="">` : ''}
      <div class="progress upload-bar"><div style="width:${Math.round(u.progress * 100)}%"></div></div></div>
    <div class="book-info"><div class="book-text"><div class="book-title">${esc(u.title)}</div>
    <div class="book-sub">Uploading… ${Math.round(u.progress * 100)}%</div></div></div>
  </div>`;
}

function bindCards(root) {
  root.querySelectorAll('.book[data-id]').forEach((el) => {
    const book = state.books.find((b) => b.id === el.dataset.id);
    if (!book) return;
    bindBookGestures(el, book);
    el.querySelector('.more').onclick = () => bookMenu(book);
  });
  root.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => navigate(`/read/${b.dataset.open}`)));
  root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => navigate(b.dataset.go)));
  root.querySelectorAll('[data-action="upload"]').forEach((b) => (b.onclick = () => shell.querySelector('.file-input').click()));
}

const emptyLibraryHtml = () => `
  <div class="empty">${ICONS.book}
    <h2>Your library is empty</h2>
    <p>Add a PDF or ePUB and it will be saved to your account, ready on every device.</p>
    <button class="btn primary" data-action="upload">Add a Book</button>
  </div>`;

// ------------------------------------------------------------------ views
function renderShelf() {
  if (!shell || !app.contains(shell)) return;
  const main = shell.querySelector('.k-main');
  if (state.query.trim()) main.innerHTML = searchHtml();
  else if (state.view === 'library') main.innerHTML = libraryHtml();
  else if (state.view === 'settings') main.innerHTML = settingsHtml();
  else if (state.view === 'reviews') main.innerHTML = reviewsHtml();
  else if (state.view === 'about') main.innerHTML = aboutHtml();
  else main.innerHTML = recoveryNotice() + homeHtml();
  bindCards(main);
  main.querySelector('[data-notice="recovery"]')?.addEventListener('click', createRecoveryKey);
  main.querySelector('[data-notice="dismiss"]')?.addEventListener('click', () => {
    try { localStorage.setItem('bindr:recovery-dismissed', state.user.id); } catch {}
    renderShelf();
  });
  if (state.view === 'library' && !state.query.trim()) bindLibraryBar(main);
  if (state.view === 'settings' && !state.query.trim()) bindSettings(main);
  if (state.view === 'about' && !state.query.trim()) bindAbout(main);
}

/** Home: nudge accounts made before recovery keys existed to set one up. */
function recoveryNotice() {
  if (!state.user || state.user.hasRecoveryKey || state.user.hasRecoveryKey === undefined) return '';
  try { if (localStorage.getItem('bindr:recovery-dismissed') === state.user.id) return ''; } catch {}
  return `<section class="k-notice">
    <div><strong>Set up a recovery key</strong><p>It lets you get back into your account if you forget your password.</p></div>
    <div class="k-notice-actions">
      <button class="btn" data-notice="dismiss">Not now</button>
      <button class="btn primary" data-notice="recovery">Set Up</button>
    </div>
  </section>`;
}

function shelfRow(title, books, { link } = {}) {
  if (!books.length) return '';
  return `<section class="k-section">
    <div class="k-section-head"><h2>${esc(title)}</h2>${link ? `<button class="k-link" data-go="${link}">See all ${ICONS.chev}</button>` : ''}</div>
    <div class="k-row">${books.map((b) => bookCard(b)).join('')}</div>
  </section>`;
}

function homeHtml() {
  if (!state.books.length && !state.uploads.length) return emptyLibraryHtml();
  const recent = state.books.filter((b) => b.lastOpenedAt && !isFinished(b)).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const unread = sortBooks(state.books.filter((b) => !b.lastOpenedAt), 'added');
  const current = recent[0] || unread[0];
  let hero = '';
  if (current) {
    const pct = progressPct(current);
    hero = `<section class="k-section"><div class="k-hero">
      <button class="book-open" data-open="${esc(current.id)}" aria-label="Open ${esc(current.title)}" style="width:auto">${coverHtml(current)}</button>
      <div class="k-hero-meta">
        <div class="k-eyebrow">${pct === null ? 'Start reading' : 'Jump back in'}</div>
        <div class="k-hero-title">${esc(current.title)}</div>
        ${current.author ? `<div class="k-hero-author">${esc(current.author)}</div>` : ''}
        <div class="k-hero-progress">${pct === null ? `${current.pageCount ? `${current.pageCount} pages · ` : ''}Not started`
          : `Page ${current.currentPage} of ${current.pageCount || '?'} · ${pct}%<div class="progress"><div style="width:${pct}%"></div></div>`}</div>
        <button class="btn primary" data-open="${esc(current.id)}">${pct === null ? 'Start Reading' : 'Continue Reading'}</button>
      </div>
    </div></section>`;
  }
  const uploads = state.uploads.map(uploadCard).join('');
  const libraryRow = sortBooks(state.books, 'recent').filter((b) => b !== current).slice(0, 14);
  const rated = state.books.filter((b) => b.rating).sort((a, b) => b.rating - a.rating).slice(0, 14);
  const finished = state.books.filter(isFinished).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, 14);
  return `${hero}
    ${uploads ? `<section class="k-section"><div class="k-section-head"><h2>Uploading</h2></div><div class="k-row">${uploads}</div></section>` : ''}
    ${shelfRow('Your Library', libraryRow, { link: '/library' })}
    ${shelfRow('Recently Added', sortBooks(state.books, 'added').slice(0, 14), { link: '/library' })}
    ${shelfRow('Rated by You', rated, { link: '/reviews' })}
    ${shelfRow('Finished', finished)}`;
}

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'reading', label: 'Reading', test: (b) => b.lastOpenedAt && !isFinished(b) },
  { id: 'unread', label: 'Unread', test: (b) => !b.lastOpenedAt },
  { id: 'finished', label: 'Finished', test: isFinished },
  { id: 'rated', label: 'Rated', test: (b) => !!b.rating },
];

function libraryHtml() {
  const filter = FILTERS.find((f) => f.id === state.libFilter) || FILTERS[0];
  const books = sortBooks(state.books.filter(filter.test), state.sort);
  const list = state.libLayout === 'list';
  const uploads = filter.id === 'all' && !list ? state.uploads.map(uploadCard).join('') : '';
  const body = !state.books.length && !state.uploads.length ? emptyLibraryHtml()
    : books.length || uploads
      ? `<div class="${list ? 'k-list' : 'grid'}">${uploads}${books.map((b) => bookCard(b, { list })).join('')}</div>`
      : `<div class="empty"><h2>No ${esc(filter.label.toLowerCase())} books</h2><p>Try another filter.</p></div>`;
  return `<h1 class="k-page-title">Library</h1>
    <div class="k-libbar">
      <div class="k-filters" role="tablist">${FILTERS.map((f) => `<button class="k-chip ${f.id === filter.id ? 'active' : ''}" data-filter="${f.id}" role="tab">${f.label}</button>`).join('')}</div>
      <select class="k-select" data-sort aria-label="Sort">
        ${[['recent', 'Recent'], ['title', 'Title'], ['author', 'Author'], ['added', 'Date Added']].map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <div class="k-viewtoggle" role="group" aria-label="View">
        <button data-layout="grid" class="${list ? '' : 'active'}" aria-label="Grid view">${ICONS.grid}</button>
        <button data-layout="list" class="${list ? 'active' : ''}" aria-label="List view">${ICONS.list}</button>
      </div>
    </div>
    ${body}`;
}

function bindLibraryBar(main) {
  main.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => {
    state.libFilter = b.dataset.filter;
    localStorage.setItem('bindr:lib-filter', state.libFilter);
    renderShelf();
  }));
  main.querySelector('[data-sort]').onchange = (e) => {
    state.sort = e.target.value;
    localStorage.setItem('bindr:sort', state.sort);
    renderShelf();
  };
  main.querySelectorAll('[data-layout]').forEach((b) => (b.onclick = () => {
    state.libLayout = b.dataset.layout;
    localStorage.setItem('bindr:lib-layout', state.libLayout);
    renderShelf();
  }));
}

function searchHtml() {
  const q = state.query.trim().toLowerCase();
  const books = sortBooks(state.books.filter((b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)), 'title');
  return `<h1 class="k-page-title">Results</h1>
    <p class="book-sub" style="margin:0 0 12px">${books.length} in your library for “${esc(state.query.trim())}”</p>
    ${books.length ? `<div class="k-list">${books.map((b) => bookCard(b, { list: true })).join('')}</div>`
      : '<div class="empty"><h2>No matches</h2><p>Try a different title or author.</p></div>'}`;
}

function reviewsHtml() {
  const rated = state.books.filter((b) => b.rating).sort((a, b) => b.rating - a.rating || a.title.localeCompare(b.title));
  return `<h1 class="k-page-title">Ratings & Reviews</h1>
    ${rated.length ? `<div class="k-list" style="border-top:0">${rated.map((b) => `
      <div class="k-review-item book" data-id="${esc(b.id)}">
        <button class="book-open" aria-label="Open ${esc(b.title)}" style="width:64px;flex:none">${coverHtml(b)}</button>
        <div class="book-info" style="margin:0;align-items:flex-start;flex:1">
          <div class="book-text">
            <div class="book-title">${esc(b.title)}</div>
            <div class="book-meta">${starsHtml(b.rating, 13)}<span>${fmtRating(b.rating)}</span></div>
            ${b.reviewTitle ? `<div class="r-title">${esc(b.reviewTitle)}</div>` : ''}
            ${b.reviewBody ? `<p>${esc(b.reviewBody).replace(/\n/g, '<br>')}</p>` : ''}
          </div>
          <button class="more" aria-label="More options for ${esc(b.title)}">${ICONS.more}</button>
        </div>
      </div>`).join('')}</div>`
      : `<div class="empty">${ICONS.book}<h2>No ratings yet</h2><p>Double-tap or press and hold a book's cover to rate and review it.</p></div>`}`;
}

function settingsHtml() {
  const u = state.user;
  const mb = state.books.reduce((n, b) => n + (b.size || 0), 0) / 1048576;
  let layout = 'auto';
  let turnMode = 'curl';
  try {
    layout = localStorage.getItem('bindr:layout') || 'auto';
    turnMode = localStorage.getItem('bindr:turn') || 'curl';
  } catch {}
  const row = (action, label, value = '', cls = '') =>
    `<button class="k-rowitem ${cls}" data-set="${action}"><span>${label}</span><span class="k-val">${esc(value)}${ICONS.chev}</span></button>`;
  const info = (label, value) => `<div class="k-rowitem"><span>${label}</span><span class="k-val">${esc(value)}</span></div>`;
  return `<h1 class="k-page-title">Settings</h1>
    <div class="k-group-title">Your Account</div>
    <div class="k-rows">
      ${row('name', 'Name', u.name)}
      ${u.verified ? info('Email', u.email) : row('verify', 'Email', `${u.email} · Not verified`)}
      ${u.verified ? info('Email Status', 'Verified ✓') : ''}
      ${row('password', 'Change Password')}
      ${row('recovery', 'Recovery Key', u.hasRecoveryKey ? 'Set up' : 'Not set up')}
      ${row('logout', 'Sign Out')}
    </div>
    <div class="k-group-title">Display</div>
    <div class="k-rows">
      ${row('theme', 'Dark Mode', THEME_LABEL[uiTheme()])}
      ${row('layout', 'Page Layout', LAYOUT_LABEL[layout] || 'Automatic')}
      ${row('turn', 'Page Turn Animation', TURN_LABEL[turnMode] || 'Curl')}
      ${row('filter', 'Color Filter', filterLabel())}
    </div>
    <div class="k-group-title">Device</div>
    <div class="k-rows">
      ${deferredInstall ? row('install', 'Install Bindr App') : ''}
      ${row('sync', 'Sync Your Library')}
      ${info('Storage', `${state.books.length} book${state.books.length === 1 ? '' : 's'} · ${mb.toFixed(1)} MB`)}
    </div>
    <div class="k-group-title">About</div>
    <div class="k-rows">
      ${row('help', 'Help')}
      ${row('delete', 'Delete Account', '', 'danger')}
    </div>`;
}

function bindSettings(main) {
  main.querySelectorAll('[data-set]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.set;
    if (a === 'name') changeName();
    if (a === 'password') changePassword();
    if (a === 'verify') showVerify({ optional: true });
    if (a === 'recovery') createRecoveryKey();
    if (a === 'logout') signOut();
    if (a === 'delete') deleteAccount();
    if (a === 'sync') syncLibrary();
    if (a === 'help') helpSheet();
    if (a === 'install' && deferredInstall) { deferredInstall.prompt(); deferredInstall = null; renderShelf(); }
    if (a === 'theme') {
      const t = await menu('Dark Mode', [
        { label: 'Automatic (match this device)', value: 'auto' },
        { label: 'On', value: 'dark' },
        { label: 'Off', value: 'light' },
      ]);
      if (t) { setUiTheme(t); renderShelf(); }
    }
    if (a === 'filter') filterSheet();
    if (a === 'turn') {
      const t = await menu('Page Turn Animation', [
        { label: 'Curl: the page curls like paper', value: 'curl' },
        { label: 'Slide: pages slide sideways', value: 'slide' },
        { label: 'Instant: no animation', value: 'instant' },
      ]);
      if (t) { try { localStorage.setItem('bindr:turn', t); } catch {} renderShelf(); }
    }
    if (a === 'layout') {
      const l = await menu('Page Layout', [
        { label: 'Automatic (two pages on wide screens)', value: 'auto' },
        { label: 'One page', value: 'single' },
        { label: 'Two pages when there is room', value: 'double' },
      ]);
      if (l) {
        try { if (l === 'auto') localStorage.removeItem('bindr:layout'); else localStorage.setItem('bindr:layout', l); } catch {}
        renderShelf();
      }
    }
  }));
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
  return updated;
}

async function bookMenu(book) {
  const choice = await menu(book.title, [
    { label: 'Read', value: 'read' },
    { label: book.rating ? `Rate & Review (${fmtRating(book.rating)} ★)` : 'Rate & Review', value: 'rate' },
    { label: book.pageTheme === 'dark' ? 'Page Theme: Dark (switch to Light)' : 'Page Theme: Light (switch to Dark)', value: 'theme' },
    { label: 'Rename / Edit Details', value: 'rename' },
    isFinished(book) || !book.pageCount ? null : { label: 'Mark as Read', value: 'finish' },
    book.lastOpenedAt ? { label: 'Mark as Unread', value: 'reset' } : null,
    { label: 'Remove from Library', value: 'delete', danger: true },
  ]);
  if (choice === 'read') navigate(`/read/${book.id}`);
  if (choice === 'rename') renameBook(book);
  if (choice === 'rate') rateBook(book);
  if (choice === 'theme') {
    try {
      replaceBook((await api.updateBook(book.id, { pageTheme: book.pageTheme === 'dark' ? 'light' : 'dark' })).book);
      renderShelf();
    } catch (e) { toast(e.message); }
  }
  if (choice === 'finish') {
    try {
      replaceBook((await api.updateBook(book.id, { currentPage: book.pageCount, pageCount: book.pageCount })).book);
      renderShelf();
    } catch (e) { toast(e.message); }
  }
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
  // Some file pickers (Android in particular) give files no extension or type, so fall back
  // to the file's first bytes: "%PDF" for PDF, "PK" (a ZIP) for ePUB.
  const sniffed = new Map(await Promise.all(files.map(async (f) => {
    if (/\.(pdf|epub)$/i.test(f.name) || ['application/pdf', 'application/epub+zip'].includes(f.type)) return [f, null];
    try {
      const head = new Uint8Array(await f.slice(0, 1024).arrayBuffer());
      const text = String.fromCharCode(...head);
      return [f, text.includes('%PDF-') ? 'pdf' : head[0] === 0x50 && head[1] === 0x4b ? 'epub' : null];
    } catch { return [f, null]; }
  })));
  const isEpub = (f) => f.type === 'application/epub+zip' || /\.epub$/i.test(f.name) || sniffed.get(f) === 'epub';
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name) || isEpub(f) || sniffed.get(f) === 'pdf');
  if (pdfs.length < files.length) toast('Only PDF and ePUB books can be added.');
  if (!pdfs.length) return;

  // Read metadata + covers so the user can name each book before uploading.
  const items = await Promise.all(pdfs.map(async (file) => {
    const fallback = file.name.replace(/\.(pdf|epub)$/i, '').replace(/[_]+/g, ' ').trim();
    try {
      const info = isEpub(file)
        ? await (await import('./epub.js')).EpubDoc.inspect(new Uint8Array(await file.arrayBuffer()))
        : await inspectPdf(file);
      return { file, ...info, title: info.title || fallback, coverUrl: info.cover && URL.createObjectURL(info.cover) };
    } catch (e) {
      console.warn('Could not read PDF', file.name, e);
      return { file, title: fallback, author: '', pageCount: 0, cover: null, broken: true, error: e?.message };
    }
  }));

  const valid = items.filter((it) => !it.broken);
  const broken = items.filter((it) => it.broken);
  if (broken.length === 1) toast(`“${broken[0].file.name}” couldn’t be read: ${broken[0].error || 'it doesn’t look like a PDF or ePUB.'}`);
  else if (broken.length) toast(`${broken.length} files couldn’t be read as books.`);
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
        const bar = shell?.querySelectorAll('.book.uploading')[state.uploads.indexOf(entry)];
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
      renderShelf();
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
  const { id, currentPage, pageCount, location } = pendingProgress;
  pendingProgress = null;
  const fields = { currentPage, pageCount, ...(location != null ? { location } : {}) };
  api.updateBook(id, fields)
    .then(({ book }) => { replaceBook(book); })
    .catch(() => {
      // Offline: remember locally and retry next time we're online.
      const q = JSON.parse(localStorage.getItem('bindr:pending') || '{}');
      q[id] = fields;
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

  const pending = JSON.parse(localStorage.getItem('bindr:pending') || '{}')[book.id];
  const start = pending?.currentPage || book.currentPage || 1;
  if (pending?.location != null) book.location = pending.location;

  const reader = new Reader(view, book, {
    // Dark/light pages are saved per book, so they follow the book to your other devices.
    onPageTheme: (pageTheme) => {
      const local = state.books.find((b) => b.id === book.id);
      if (local) local.pageTheme = pageTheme;
      saveBooksLocal();
      api.updateBook(book.id, { pageTheme }).catch(() => toast('Couldn’t save the page theme. Check your connection.'));
    },
    onRate: (b) => rateBook(state.books.find((x) => x.id === b.id) || b),
    onChapters: (chapters) => {
      const local = state.books.find((b) => b.id === book.id);
      if (local) local.chapters = chapters;
      saveBooksLocal();
      api.updateBook(book.id, { chapters }).then((r) => replaceBook(r.book)).catch(() => toast('Couldn’t save your chapters. Check your connection.'));
    },
    onClose: () => {
      if (pushedReader) { pushedReader = false; history.back(); }
      else { history.replaceState(null, '', '/'); route(); }
    },
    onProgress: (page, pageCount, location = null) => {
      const local = state.books.find((b) => b.id === book.id);
      if (local) Object.assign(local, { currentPage: page, pageCount, lastOpenedAt: Date.now(), ...(location != null ? { location } : {}) });
      saveBooksLocal();
      pendingProgress = { id: book.id, currentPage: page, pageCount, location: location ?? pendingProgress?.location ?? null };
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
