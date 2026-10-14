'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Storage: everything persistent (SQLite DB + uploaded PDFs + covers) lives in
// DATA_DIR. On Railway, attach a volume and it is picked up automatically via
// RAILWAY_VOLUME_MOUNT_PATH (or set DATA_DIR yourself).
// ---------------------------------------------------------------------------
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data')
);
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
for (const dir of [DATA_DIR, BOOKS_DIR, COVERS_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

const PORT = Number(process.env.PORT) || 3000;
const DICTIONARY_URL = process.env.DICTIONARY_URL || 'https://api.dictionaryapi.dev/api/v2/entries/en/';
// Accounts allowed to edit the About page (comma-separated emails).
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || 'ljmiller2389@gmail.com')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
const isAdminEmail = (email) => ADMIN_EMAILS.has(String(email).toLowerCase());
// Admin rights also need the owner check (a code from the server log), so nobody can
// claim them just by signing up with the address. `email_verified` records that check.
const isAdmin = (user) => !!user && !!user.email_verified && isAdminEmail(user.email);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 300;
const SESSION_DAYS = 60;
const COOKIE = 'bindr_session';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(path.join(DATA_DIR, 'bindr.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS books (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    author         TEXT NOT NULL DEFAULT '',
    original_name  TEXT NOT NULL,
    size           INTEGER NOT NULL,
    page_count     INTEGER NOT NULL DEFAULT 0,
    current_page   INTEGER NOT NULL DEFAULT 1,
    has_cover      INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_opened_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS books_user ON books(user_id);
`);

// Columns added after the first release.
{
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  const add = (name, def) => { if (!cols.includes(name)) db.exec(`ALTER TABLE books ADD COLUMN ${name} ${def}`); };
  add('rating', 'REAL');
  add('review_title', "TEXT NOT NULL DEFAULT ''");
  add('review_body', "TEXT NOT NULL DEFAULT ''");
  add('reviewed_at', 'INTEGER');
  add('page_theme', "TEXT NOT NULL DEFAULT 'light'"); // per-book page theme: 'light' | 'dark'
  add('format', "TEXT NOT NULL DEFAULT 'pdf'");       // 'pdf' | 'epub'
  add('location', 'INTEGER');                          // ePUB reading position (character offset)
  add('chapters', 'TEXT');                             // chapters the reader added: JSON [{title, page, loc}]
  add('review_public', 'INTEGER NOT NULL DEFAULT 0');  // 1 = the review is shared in the Book Store
}
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  if (cols.includes('recovery_hash')) db.exec('ALTER TABLE users DROP COLUMN recovery_hash'); // old recovery keys
  if (!cols.includes('recovery_code')) db.exec('ALTER TABLE users ADD COLUMN recovery_code TEXT'); // 6-digit recovery code
  if (!cols.includes('recovery_fails')) db.exec('ALTER TABLE users ADD COLUMN recovery_fails INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('recovery_locked_until')) db.exec('ALTER TABLE users ADD COLUMN recovery_locked_until INTEGER');
}
db.exec('DROP TABLE IF EXISTS email_codes');

db.exec(`
  CREATE TABLE IF NOT EXISTS highlights (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page       INTEGER,            -- PDF page (null for ePUB, whose offsets are book-wide)
    start      INTEGER NOT NULL,   -- character offsets into the page (PDF) or book (ePUB) text
    end        INTEGER NOT NULL,
    text       TEXT NOT NULL,
    color      TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS highlights_book ON highlights(book_id, user_id);
  CREATE TABLE IF NOT EXISTS site_pages (
    slug       TEXT PRIMARY KEY,   -- e.g. 'about'
    content    TEXT NOT NULL,      -- Markdown
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS owner_codes (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    sent_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS definitions (
    word       TEXT PRIMARY KEY,
    data       TEXT,               -- JSON, or NULL when the word wasn't found
    fetched_at INTEGER NOT NULL
  );
`);

// Clean up after the Book Store, which has been removed. Books people added from it
// stay in their libraries as ordinary books.
db.exec('DROP TABLE IF EXISTS store_reviews; DROP TABLE IF EXISTS store_items;');
if (db.prepare('PRAGMA table_info(books)').all().some((c) => c.name === 'store_id')) {
  db.exec('ALTER TABLE books DROP COLUMN store_id');
}
fs.rm(path.join(DATA_DIR, 'store'), { recursive: true, force: true }, () => {});

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, created_at, email_verified FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
  updateUserName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  updateUserPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(`
    SELECT u.id, u.email, u.name, u.created_at, u.email_verified FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
  deleteAllUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  setVerified: db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
  setRecovery: db.prepare('UPDATE users SET recovery_code = ?, recovery_fails = 0, recovery_locked_until = NULL WHERE id = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  listBooks: db.prepare(`SELECT * FROM books WHERE user_id = ?
    ORDER BY COALESCE(last_opened_at, created_at) DESC`),
  getBook: db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?'),
  insertBook: db.prepare(`INSERT INTO books
    (id, user_id, title, author, original_name, size, page_count, has_cover, created_at, updated_at)
    VALUES (@id, @user_id, @title, @author, @original_name, @size, @page_count, @has_cover, @now, @now)`),
  deleteBook: db.prepare('DELETE FROM books WHERE id = ? AND user_id = ?'),
  userBookIds: db.prepare('SELECT id FROM books WHERE user_id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(12).toString('base64url');

function publicBook(b) {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    originalName: b.original_name,
    size: b.size,
    pageCount: b.page_count,
    currentPage: b.current_page,
    hasCover: !!b.has_cover,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    lastOpenedAt: b.last_opened_at,
    rating: b.rating ?? null,
    reviewTitle: b.review_title || '',
    reviewBody: b.review_body || '',
    reviewPublic: !!b.review_public,
    pageTheme: b.page_theme === 'dark' ? 'dark' : 'light',
    format: b.format === 'epub' ? 'epub' : 'pdf',
    location: b.location ?? null,
    chapters: parseChapters(b.chapters),
  };
}

function parseChapters(json) {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Like cleanText, but keeps line breaks (for review bodies). */
function cleanMultiline(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// --- sessions --------------------------------------------------------------
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  q.insertSession.run(sha256(token), userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  });
}

// What the app sees of an account.
function userJson(u) {
  return { id: u.id, email: u.email, name: u.name, created_at: u.created_at };
}

function auth(req, res, next) {
  const token = req.cookies[COOKIE];
  const user = token && q.sessionUser.get(sha256(token), Date.now());
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  req.tokenHash = sha256(token);
  next();
}

setInterval(() => {
  q.purgeSessions.run(Date.now());
  db.prepare('DELETE FROM owner_codes WHERE expires_at <= ?').run(Date.now());
}, 6 * 3600e3).unref();

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sendError = (res, err) => {
  if (!err.status) throw err;
  res.status(err.status).json({ error: err.message });
};
const newSixDigits = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
const sameCode = (a, b) => a.length === 6 && b.length === 6 && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// --- recovery codes --------------------------------------------------------------
// Every account has a 6-digit recovery code, shown when it's created and any time in
// Settings. With the account's email it sets a new password. Five wrong tries lock it
// for an hour, so it can't be guessed; each use replaces it with a new one.
const RECOVERY_TRIES = 5;
const RECOVERY_LOCK_MS = 3600e3;

function newRecoveryCode(userId) {
  const code = newSixDigits();
  q.setRecovery.run(code, userId);
  return code;
}

/** The account's recovery code, making one for accounts created before codes existed. */
function recoveryCodeOf(user) {
  const row = db.prepare('SELECT recovery_code FROM users WHERE id = ?').get(user.id);
  return row?.recovery_code || newRecoveryCode(user.id);
}

// --- owner check ---------------------------------------------------------------------
// Editing the About page needs the account to be one of ADMIN_EMAILS *and* to have proven
// it belongs to whoever runs the server: a 6-digit code written only to the server log
// (Railway → Deployments → Logs). Anyone can sign up with an email address, but only the
// owner can read the log. The same code also lets the owner take back their address if
// someone else signed up with it.
const OWNER_CODE_MINUTES = 15;

function writeOwnerCode(user) {
  const now = Date.now();
  const prev = db.prepare('SELECT sent_at FROM owner_codes WHERE user_id = ?').get(user.id);
  if (prev && now - prev.sent_at < 30e3) {
    throw httpError(429, `Please wait ${Math.ceil((30e3 - (now - prev.sent_at)) / 1000)} seconds before asking for another code.`);
  }
  const code = newSixDigits();
  db.prepare(`INSERT INTO owner_codes (user_id, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`)
    .run(user.id, sha256(`owner:${user.id}:${code}`), now + OWNER_CODE_MINUTES * 60e3, now);
  console.log(`[owner] Owner code for ${user.email}: ${code} (expires in ${OWNER_CODE_MINUTES} minutes)`);
}

/** True if the owner code is right (and uses it up). Five wrong tries and it stops working. */
function ownerCodeMatches(user, input) {
  const row = db.prepare('SELECT * FROM owner_codes WHERE user_id = ?').get(user.id);
  if (!row || row.expires_at <= Date.now() || row.attempts >= 5) return false;
  const code = digitsOf(input);
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(sha256(`owner:${user.id}:${code}`)), Buffer.from(row.code_hash));
  if (ok) db.prepare('UPDATE owner_codes SET expires_at = 0 WHERE user_id = ?').run(user.id);
  else db.prepare('UPDATE owner_codes SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
  return ok;
}

// Tiny in-memory rate limiter for auth endpoints.
const attempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60e3 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 15 * 60e3; }
  entry.count++;
  attempts.set(key, entry);
  if (entry.count > 30) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now > v.reset) attempts.delete(k);
}, 15 * 60e3).unref();

// --- auth routes -----------------------------------------------------------
const STORAGE_FULL = 'The server has run out of storage space. Ask the person who runs Bindr to make its Railway volume bigger.';

// Health check, plus how full the data volume is (handy when uploads start failing).
app.get('/api/health', (req, res) => {
  let storage;
  try {
    const st = fs.statfsSync(DATA_DIR);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    storage = { totalMB: Math.round(total / 1048576), freeMB: Math.round(free / 1048576), usedPercent: total ? Math.round((1 - free / total) * 100) : null };
  } catch {}
  res.json({ ok: true, storage });
});

const passwordError = (pw) => (pw.length < 8 ? 'Password must be at least 8 characters.' : pw.length > 200 ? 'Password is too long.' : null);

app.post('/api/auth/register', rateLimit, async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const name = cleanText(req.body?.name, 80) || email.split('@')[0];
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (passwordError(password)) return res.status(400).json({ error: passwordError(password) });
  if (q.userByEmail.get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists. If it\'s yours, sign in, or use "Forgot password?" with your recovery code.' });
  }
  const id = newId();
  q.insertUser.run(id, email, name, await bcrypt.hash(password, 12), Date.now());
  const recoveryCode = newRecoveryCode(id);
  startSession(res, id);
  res.status(201).json({ user: userJson(q.userById.get(id)), recoveryCode });
});

app.post('/api/auth/login', rateLimit, async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = q.userByEmail.get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  startSession(res, user.id);
  res.json({ user: userJson(q.userById.get(user.id)) });
});

// Forgot password: email + the account's 6-digit recovery code (or, for the owner's
// address only, an owner code from the server log) sets a new password.
app.post('/api/auth/reset', rateLimit, async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const code = digitsOf(req.body?.code);
  const user = q.userByEmail.get(email);
  const wrong = () => res.status(400).json({ error: 'That email and code don\'t match.' });
  if (passwordError(password)) return res.status(400).json({ error: passwordError(password) });
  if (!user) return wrong();
  const now = Date.now();
  if (user.recovery_locked_until > now) {
    const mins = Math.ceil((user.recovery_locked_until - now) / 60e3);
    return res.status(429).json({ error: `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
  }
  const byRecovery = !!user.recovery_code && sameCode(code, user.recovery_code);
  const byOwner = !byRecovery && isAdminEmail(email) && ownerCodeMatches(user, code);
  if (!byRecovery && !byOwner) {
    const fails = user.recovery_fails + 1;
    db.prepare('UPDATE users SET recovery_fails = ?, recovery_locked_until = ? WHERE id = ?')
      .run(fails >= RECOVERY_TRIES ? 0 : fails, fails >= RECOVERY_TRIES ? now + RECOVERY_LOCK_MS : null, user.id);
    return wrong();
  }
  q.updateUserPassword.run(await bcrypt.hash(password, 12), user.id);
  db.prepare('UPDATE users SET recovery_fails = 0, recovery_locked_until = NULL WHERE id = ?').run(user.id);
  if (byOwner) q.setVerified.run(user.id);
  q.deleteAllUserSessions.run(user.id); // sign out everyone else using the account
  // A new recovery code, so whoever had the old one (or the account) can't use it again.
  const recoveryCode = newRecoveryCode(user.id);
  startSession(res, user.id);
  res.json({ user: userJson(q.userById.get(user.id)), recoveryCode });
});

// The owner's address only: write an owner code to the server log for a password reset.
// Same answer for every address, so it says nothing about which accounts exist.
app.post('/api/auth/owner-code', rateLimit, (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const user = isAdminEmail(email) && q.userByEmail.get(email);
  if (user) try { writeOwnerCode(user); } catch {}
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies[COOKIE];
  if (token) q.deleteSession.run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: userJson(req.user) }));

app.patch('/api/me', auth, async (req, res) => {
  if (req.body?.name !== undefined) {
    const name = cleanText(req.body.name, 80);
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
    q.updateUserName.run(name, req.user.id);
  }
  if (req.body?.newPassword !== undefined) {
    const full = q.userByEmail.get(req.user.email);
    if (!(await bcrypt.compare(String(req.body.currentPassword || ''), full.password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    const pw = String(req.body.newPassword);
    if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    q.updateUserPassword.run(await bcrypt.hash(pw, 12), req.user.id);
    q.deleteUserSessions.run(req.user.id, req.tokenHash);
  }
  res.json({ user: userJson(q.userById.get(req.user.id)) });
});

// The signed-in account's recovery code (Settings → Recovery Code).
app.get('/api/me/recovery-code', auth, (req, res) => res.json({ recoveryCode: recoveryCodeOf(req.user) }));

// A new recovery code; the old one stops working. Needs the password.
app.post('/api/me/recovery-code', rateLimit, auth, async (req, res) => {
  const full = q.userByEmail.get(req.user.email);
  if (!(await bcrypt.compare(String(req.body?.password || ''), full.password_hash))) {
    return res.status(400).json({ error: 'Password is incorrect.' });
  }
  res.json({ recoveryCode: newRecoveryCode(req.user.id) });
});

// Owner check for the About page (see "owner check" above).
app.post('/api/owner/code', rateLimit, auth, (req, res) => {
  if (!isAdminEmail(req.user.email)) return res.status(403).json({ error: 'Only the owner of Bindr can do this.' });
  try { writeOwnerCode(req.user); } catch (err) { return sendError(res, err); }
  res.json({ ok: true });
});

app.post('/api/owner/verify', rateLimit, auth, (req, res) => {
  if (!isAdminEmail(req.user.email)) return res.status(403).json({ error: 'Only the owner of Bindr can do this.' });
  if (!req.user.email_verified && !ownerCodeMatches(req.user, req.body?.code)) {
    return res.status(400).json({ error: 'That code isn\'t right, or it has expired. Check the server log, or ask for a new code.' });
  }
  q.setVerified.run(req.user.id);
  res.json({ ok: true });
});

app.delete('/api/me', auth, async (req, res) => {
  const full = q.userByEmail.get(req.user.email);
  if (!(await bcrypt.compare(String(req.body?.password || ''), full.password_hash))) {
    return res.status(400).json({ error: 'Password is incorrect.' });
  }
  for (const { id } of q.userBookIds.all(req.user.id)) removeBookFiles(id);
  q.deleteUser.run(req.user.id);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// --- books -----------------------------------------------------------------
const bookPath = (id, format = 'pdf') => path.join(BOOKS_DIR, `${id}.${format === 'epub' ? 'epub' : 'pdf'}`);
const coverPath = (id) => path.join(COVERS_DIR, `${id}.jpg`);

function removeBookFiles(id) {
  fs.rm(bookPath(id, 'pdf'), { force: true }, () => {});
  fs.rm(bookPath(id, 'epub'), { force: true }, () => {});
  fs.rm(coverPath(id), { force: true }, () => {});
}

/** 'pdf', 'epub', or null for anything else. */
function detectFormat(file) {
  const head = readHead(file, 1024);
  // The %PDF header may be preceded by a little junk, which readers tolerate.
  if (head.includes(Buffer.from('%PDF-'))) return 'pdf';
  // An ePUB is a ZIP containing META-INF/container.xml. Real-world ePUBs don't always put
  // the "mimetype" entry first (or store it uncompressed), so look at the ZIP's file list.
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    if (head.includes(Buffer.from('application/epub+zip'))) return 'epub';
    try {
      if (zipEntryNames(file).some((n) => n.toLowerCase() === 'meta-inf/container.xml')) return 'epub';
    } catch (e) {
      console.warn('Could not read ZIP directory:', e.message);
    }
  }
  return null;
}

/** File names in a ZIP archive, read from its central directory (supports ZIP64). */
function zipEntryNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos, len) => {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      return buf.subarray(0, n);
    };
    // End of central directory record: within the last 64 KiB + 22 bytes.
    const tailLen = Math.min(size, 65557);
    const tail = read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('no end-of-central-directory record');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
      // ZIP64: the locator sits just before the EOCD record.
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('bad zip64 locator');
      const z64 = read(Number(tail.readBigUInt64LE(loc + 8)), 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('bad zip64 record');
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    if (cdSize > 64 * 1024 * 1024) throw new Error('central directory too large');
    const cd = read(cdOffset, cdSize);
    const names = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2, fields: 10 },
});

function readHead(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

app.get('/api/books', auth, (req, res) => {
  res.json({ books: q.listBooks.all(req.user.id).map(publicBook) });
});

app.post('/api/books', auth, (req, res) => {
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(req, res, (err) => {
    const pdf = req.files?.file?.[0];
    const cover = req.files?.cover?.[0];
    const cleanup = () => { for (const f of [pdf, cover]) if (f) fs.rm(f.path, { force: true }, () => {}); };
    if (err) {
      cleanup();
      console.error(`Upload failed for user ${req.user.id}:`, err.code || '', err.message);
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_UPLOAD_MB} MB.`
        : err.code === 'ENOSPC' ? STORAGE_FULL
          : `Upload failed (${err.code || err.message}).`;
      return res.status(400).json({ error: msg });
    }
    if (!pdf) { cleanup(); return res.status(400).json({ error: 'No book file was provided.' }); }
    const format = detectFormat(pdf.path);
    if (!format) {
      cleanup();
      return res.status(400).json({ error: 'That file is not a valid PDF or ePUB.' });
    }
    let hasCover = false;
    if (cover) {
      const head = readHead(cover.path, 3);
      hasCover = cover.size < 5 * 1024 * 1024 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    }

    const id = newId();
    const originalName = cleanText(pdf.originalname, 255) || 'book.pdf';
    const fallbackTitle = originalName.replace(/\.(pdf|epub)$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
    try {
      fs.renameSync(pdf.path, bookPath(id, format));
      if (hasCover) fs.renameSync(cover.path, coverPath(id));
      else if (cover) fs.rm(cover.path, { force: true }, () => {});
      q.insertBook.run({
        id,
        user_id: req.user.id,
        title: cleanText(req.body.title, 200) || fallbackTitle,
        author: cleanText(req.body.author, 200),
        original_name: originalName,
        size: pdf.size,
        page_count: Math.max(0, parseInt(req.body.pageCount, 10) || 0),
        has_cover: hasCover ? 1 : 0,
        now: Date.now(),
      });
      db.prepare('UPDATE books SET format = ? WHERE id = ?').run(format, id);
    } catch (e) {
      console.error(e);
      cleanup();
      removeBookFiles(id);
      return res.status(e.code === 'ENOSPC' ? 507 : 500).json({ error: e.code === 'ENOSPC' ? STORAGE_FULL : `Could not save the book (${e.code || e.message}).` });
    }
    res.status(201).json({ book: publicBook(q.getBook.get(id, req.user.id)) });
  });
});

app.patch('/api/books/:id', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const sets = [];
  const vals = {};
  if (req.body.title !== undefined) {
    const title = cleanText(req.body.title, 200);
    if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
    sets.push('title = @title'); vals.title = title;
  }
  if (req.body.author !== undefined) { sets.push('author = @author'); vals.author = cleanText(req.body.author, 200); }
  if (req.body.currentPage !== undefined) {
    sets.push('current_page = @current_page', 'last_opened_at = @now');
    vals.current_page = Math.max(1, parseInt(req.body.currentPage, 10) || 1);
  }
  if (req.body.pageCount !== undefined) { sets.push('page_count = @page_count'); vals.page_count = Math.max(0, parseInt(req.body.pageCount, 10) || 0); }
  if (req.body.pageTheme !== undefined) {
    if (!['light', 'dark'].includes(req.body.pageTheme)) return res.status(400).json({ error: 'Unknown page theme.' });
    sets.push('page_theme = @page_theme');
    vals.page_theme = req.body.pageTheme;
  }
  if (req.body.location !== undefined) {
    sets.push('location = @location');
    vals.location = Math.max(0, parseInt(req.body.location, 10) || 0);
  }
  if (req.body.chapters !== undefined) {
    if (!Array.isArray(req.body.chapters) || req.body.chapters.length > 1000) {
      return res.status(400).json({ error: 'Chapters must be a list.' });
    }
    const chapters = req.body.chapters.map((c) => ({
      title: cleanText(c?.title, 200) || 'Chapter',
      page: Math.max(1, parseInt(c?.page, 10) || 1),
      ...(Number.isFinite(Number(c?.loc)) && c?.loc !== null && c?.loc !== undefined ? { loc: Math.max(0, parseInt(c.loc, 10)) } : {}),
    }));
    sets.push('chapters = @chapters');
    vals.chapters = JSON.stringify(chapters);
  }
  if (req.body.reset) sets.push('current_page = 1', 'last_opened_at = NULL');
  if (sets.length) {
    vals.now = Date.now();
    db.prepare(`UPDATE books SET ${sets.join(', ')}, updated_at = @now WHERE id = @id AND user_id = @user_id`)
      .run({ ...vals, id: book.id, user_id: req.user.id });
  }
  res.json({ book: publicBook(q.getBook.get(book.id, req.user.id)) });
});

app.delete('/api/books/:id', auth, (req, res) => {
  const result = q.deleteBook.run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Book not found.' });
  removeBookFiles(req.params.id);
  res.json({ ok: true });
});

app.get('/api/books/:id/file', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  const type = book.format === 'epub' ? 'application/epub+zip' : 'application/pdf';
  res.sendFile(bookPath(book.id, book.format), { headers: { 'Content-Type': type } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing.' });
  });
});

app.get('/api/books/:id/cover', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book || !book.has_cover) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(coverPath(book.id), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// --- ratings & reviews -----------------------------------------------------
app.put('/api/books/:id/review', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const rating = Number(req.body?.rating);
  // 1.0 – 5.0 in half-star steps.
  if (!(rating >= 1 && rating <= 5) || Math.round(rating * 2) !== rating * 2) {
    return res.status(400).json({ error: 'Rating must be between 1.0 and 5.0 stars, in half-star steps.' });
  }
  db.prepare(`UPDATE books SET rating = ?, review_title = ?, review_body = ?, review_public = ?, reviewed_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?`).run(rating, cleanText(req.body.title, 120), cleanMultiline(req.body.body, 5000),
    req.body.public ? 1 : 0, Date.now(), Date.now(), book.id, req.user.id);
  res.json({ book: publicBook(q.getBook.get(book.id, req.user.id)) });
});

app.delete('/api/books/:id/review', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  db.prepare(`UPDATE books SET rating = NULL, review_title = '', review_body = '', reviewed_at = NULL
    WHERE id = ? AND user_id = ?`).run(book.id, req.user.id);
  res.json({ book: publicBook(q.getBook.get(book.id, req.user.id)) });
});

// --- Book Store ----------------------------------------------------------------
// Reviews people chose to share, grouped by book. It only ever shows a book's title,
// author(s) and cover, plus the reviews — never the book file — so nothing is redistributed.
// People copy "Title by Author" to find the book wherever they like to buy or borrow it.
const storeKey = (title, author) => sha256(`${title}\n${author}`.normalize('NFKD').toLowerCase()
  .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}\n]+/gu, ' ').replace(/ +/g, ' ').trim()).slice(0, 20);

function storeRows() {
  return db.prepare(`SELECT b.id, b.title, b.author, b.has_cover, b.rating, b.review_title, b.review_body, b.reviewed_at,
      b.user_id, u.name AS reviewer
    FROM books b JOIN users u ON u.id = b.user_id
    WHERE b.rating IS NOT NULL AND b.review_public = 1
    ORDER BY b.reviewed_at DESC LIMIT 5000`).all();
}

/** Groups shared reviews into store items, one per book (same title and author). */
function storeItems() {
  const items = new Map();
  for (const r of storeRows()) {
    const key = storeKey(r.title, r.author);
    let it = items.get(key);
    if (!it) {
      it = { key, title: r.title, author: r.author, coverId: null, total: 0, count: 0, lastReviewedAt: r.reviewed_at, rows: [], spellings: new Map() };
      items.set(key, it);
    }
    if (!it.coverId && r.has_cover) it.coverId = r.id;
    it.total += r.rating;
    it.count++;
    it.rows.push(r);
    const sp = `${r.title}\n${r.author}`;
    it.spellings.set(sp, (it.spellings.get(sp) || 0) + 1);
  }
  // Show the title and author as most reviewers wrote them (ties: the earliest review).
  for (const it of items.values()) {
    let best = 0;
    for (const [sp, n] of it.spellings) if (n >= best) { best = n; [it.title, it.author] = sp.split('\n'); }
  }
  return items;
}

const storeItemJson = (it) => ({
  key: it.key, title: it.title, author: it.author, coverId: it.coverId,
  rating: Math.round((it.total / it.count) * 10) / 10, reviewCount: it.count, lastReviewedAt: it.lastReviewedAt,
});

app.get('/api/store', auth, (req, res) => {
  res.json({ items: [...storeItems().values()].map(storeItemJson) });
});

app.get('/api/store/:key', auth, (req, res) => {
  const it = storeItems().get(String(req.params.key));
  if (!it) return res.status(404).json({ error: 'That book isn\'t in the Book Store any more.' });
  const admin = isAdmin(req.user);
  res.json({
    item: storeItemJson(it),
    reviews: it.rows.map((r) => ({
      id: r.id, name: r.reviewer, rating: r.rating, title: r.review_title, body: r.review_body, reviewedAt: r.reviewed_at,
      mine: r.user_id === req.user.id, canRemove: admin,
    })),
  });
});

// Covers of books with a shared review (only the cover image, never the book).
app.get('/api/store/cover/:id', auth, (req, res) => {
  const b = db.prepare('SELECT id, has_cover FROM books WHERE id = ? AND rating IS NOT NULL AND review_public = 1').get(req.params.id);
  if (!b || !b.has_cover) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(coverPath(b.id), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// The owner can take a review out of the Book Store (it stays in the reviewer's library).
app.delete('/api/store/review/:id', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the owner of Bindr can remove reviews.' });
  const r = db.prepare('UPDATE books SET review_public = 0 WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Review not found.' });
  res.json({ ok: true });
});

// --- highlights ------------------------------------------------------------
const HIGHLIGHT_COLORS = ['yellow', 'blue', 'pink', 'orange'];
const publicHighlight = (h) => ({
  id: h.id, page: h.page, start: h.start, end: h.end, text: h.text, color: h.color, note: h.note,
  createdAt: h.created_at, updatedAt: h.updated_at,
});

app.get('/api/books/:id/highlights', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const rows = db.prepare('SELECT * FROM highlights WHERE book_id = ? AND user_id = ? ORDER BY COALESCE(page, 0), start')
    .all(book.id, req.user.id);
  res.json({ highlights: rows.map(publicHighlight) });
});

app.post('/api/books/:id/highlights', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const start = parseInt(req.body?.start, 10);
  const end = parseInt(req.body?.end, 10);
  const page = req.body?.page == null ? null : parseInt(req.body.page, 10);
  const text = cleanMultiline(req.body?.text, 5000);
  const color = HIGHLIGHT_COLORS.includes(req.body?.color) ? req.body.color : 'yellow';
  if (!(start >= 0) || !(end > start) || !text || (page !== null && !(page >= 1))) {
    return res.status(400).json({ error: 'Invalid highlight.' });
  }
  const id = newId();
  const now = Date.now();
  db.prepare(`INSERT INTO highlights (id, book_id, user_id, page, start, end, text, color, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, book.id, req.user.id, page, start, end, text, color, cleanMultiline(req.body?.note, 2000), now, now);
  res.status(201).json({ highlight: publicHighlight(db.prepare('SELECT * FROM highlights WHERE id = ?').get(id)) });
});

app.patch('/api/highlights/:id', auth, (req, res) => {
  const h = db.prepare('SELECT * FROM highlights WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!h) return res.status(404).json({ error: 'Highlight not found.' });
  const color = HIGHLIGHT_COLORS.includes(req.body?.color) ? req.body.color : h.color;
  const note = req.body?.note !== undefined ? cleanMultiline(req.body.note, 2000) : h.note;
  db.prepare('UPDATE highlights SET color = ?, note = ?, updated_at = ? WHERE id = ?').run(color, note, Date.now(), h.id);
  res.json({ highlight: publicHighlight(db.prepare('SELECT * FROM highlights WHERE id = ?').get(h.id)) });
});

app.delete('/api/highlights/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM highlights WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Highlight not found.' });
  res.json({ ok: true });
});

// --- About page --------------------------------------------------------------
// Everyone signed in can read it; only admin accounts (ADMIN_EMAILS) can change it.
app.get('/api/about', auth, (req, res) => {
  const row = db.prepare("SELECT content, updated_at FROM site_pages WHERE slug = 'about'").get();
  res.json({
    content: row?.content ?? '',
    updatedAt: row?.updated_at ?? null,
    canEdit: isAdmin(req.user),
    ownerCheck: !req.user.email_verified && isAdminEmail(req.user.email), // owner, not yet checked
  });
});

app.put('/api/about', auth, (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({
      error: isAdminEmail(req.user.email) ? 'Confirm you\'re the owner (with the code from the server log) to edit the About page.' : 'Only the owner of Bindr can edit the About page.',
    });
  }
  if (typeof req.body?.content !== 'string') return res.status(400).json({ error: 'Content must be text.' });
  const content = req.body.content.replace(/\r\n?/g, '\n').slice(0, 50000);
  const now = Date.now();
  db.prepare(`INSERT INTO site_pages (slug, content, updated_at, updated_by) VALUES ('about', ?, ?, ?)
    ON CONFLICT (slug) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(content, now, req.user.id);
  res.json({ content, updatedAt: now, canEdit: true });
});

// --- dictionary ----------------------------------------------------------------
// Definitions come from the free dictionaryapi.dev service and are cached here.
app.get('/api/define/:word', auth, async (req, res) => {
  const word = String(req.params.word || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}'’-]/gu, '').replace(/’/g, "'").slice(0, 60);
  if (!word) return res.status(400).json({ error: 'No word given.' });
  const cached = db.prepare('SELECT * FROM definitions WHERE word = ?').get(word);
  const fresh = cached && (cached.data || Date.now() - cached.fetched_at < 864e5);
  if (fresh) {
    return cached.data ? res.json({ entry: JSON.parse(cached.data) }) : res.status(404).json({ error: `No definition found for “${word}”.` });
  }
  try {
    const r = await fetch(`${DICTIONARY_URL}${encodeURIComponent(word)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) {
      db.prepare('INSERT OR REPLACE INTO definitions (word, data, fetched_at) VALUES (?, NULL, ?)').run(word, Date.now());
      return res.status(404).json({ error: `No definition found for “${word}”.` });
    }
    if (!r.ok) throw new Error(`dictionary returned ${r.status}`);
    const list = await r.json();
    const first = list[0] || {};
    const meanings = [];
    for (const entry of list) {
      for (const m of entry.meanings || []) {
        let target = meanings.find((x) => x.partOfSpeech === m.partOfSpeech);
        if (!target) meanings.push((target = { partOfSpeech: m.partOfSpeech || '', definitions: [] }));
        for (const d of m.definitions || []) {
          if (target.definitions.length < 4 && d.definition) {
            target.definitions.push({ definition: String(d.definition).slice(0, 600), example: d.example ? String(d.example).slice(0, 300) : '' });
          }
        }
      }
    }
    const data = {
      word: first.word || word,
      phonetic: first.phonetic || (first.phonetics || []).find((p) => p.text)?.text || '',
      meanings: meanings.slice(0, 5),
    };
    db.prepare('INSERT OR REPLACE INTO definitions (word, data, fetched_at) VALUES (?, ?, ?)').run(word, JSON.stringify(data), Date.now());
    res.json({ entry: data });
  } catch (e) {
    console.warn('Dictionary lookup failed:', e.message);
    res.status(502).json({ error: 'The dictionary is unavailable right now.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- static front-end ------------------------------------------------------
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_DIR = path.join(PDFJS_ROOT, 'legacy', 'build');
const setMjs = (res, file) => {
  if (file.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
};
app.use('/vendor/pdfjs', express.static(PDFJS_DIR, { maxAge: '30d', setHeaders: setMjs }));
app.use('/vendor/fflate', express.static(path.join(path.dirname(require.resolve('fflate/package.json')), 'esm'), { maxAge: '30d' }));
app.use('/vendor/pdfjs-assets/cmaps', express.static(path.join(PDFJS_ROOT, 'cmaps'), { maxAge: '30d' }));
app.use('/vendor/pdfjs-assets/standard_fonts', express.static(path.join(PDFJS_ROOT, 'standard_fonts'), { maxAge: '30d' }));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, file) {
    setMjs(res, file);
    // The service worker and manifest must always be revalidated so updates roll out.
    if (/sw\.js$|\.webmanifest$|\.html$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
  },
}));
// SPA fallback
app.use((req, res) => {
  if (req.method !== 'GET') return res.status(404).end();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Bindr listening on :${PORT} (data dir: ${DATA_DIR})`);
});
