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
const STORE_DIR = path.join(DATA_DIR, 'store');
for (const dir of [DATA_DIR, BOOKS_DIR, COVERS_DIR, TMP_DIR, STORE_DIR]) fs.mkdirSync(dir, { recursive: true });

const PORT = Number(process.env.PORT) || 3000;
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

  -- Book Store: books their owners made public.
  CREATE TABLE IF NOT EXISTS store_items (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    publisher  TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 0,
    size       INTEGER NOT NULL,
    has_cover  INTEGER NOT NULL DEFAULT 0,
    downloads  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS store_reviews (
    store_id    TEXT NOT NULL REFERENCES store_items(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating      REAL NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (store_id, user_id)
  );
`);

// Columns added after the first release.
{
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  const add = (name, def) => { if (!cols.includes(name)) db.exec(`ALTER TABLE books ADD COLUMN ${name} ${def}`); };
  add('rating', 'REAL');
  add('review_title', "TEXT NOT NULL DEFAULT ''");
  add('review_body', "TEXT NOT NULL DEFAULT ''");
  add('reviewed_at', 'INTEGER');
  add('store_id', 'TEXT'); // the Book Store listing this copy is linked to (published by, or added from)
}

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
  updateUserName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  updateUserPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(`
    SELECT u.id, u.email, u.name, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  listBooks: db.prepare(`SELECT b.*, s.id AS pub_id, s.title AS pub_title, s.author AS pub_author, s.publisher AS pub_publisher
    FROM books b LEFT JOIN store_items s ON s.book_id = b.id WHERE b.user_id = ?
    ORDER BY COALESCE(b.last_opened_at, b.created_at) DESC`),
  getBook: db.prepare(`SELECT b.*, s.id AS pub_id, s.title AS pub_title, s.author AS pub_author, s.publisher AS pub_publisher
    FROM books b LEFT JOIN store_items s ON s.book_id = b.id WHERE b.id = ? AND b.user_id = ?`),
  insertBook: db.prepare(`INSERT INTO books
    (id, user_id, title, author, original_name, size, page_count, has_cover, created_at, updated_at)
    VALUES (@id, @user_id, @title, @author, @original_name, @size, @page_count, @has_cover, @now, @now)`),
  deleteBook: db.prepare('DELETE FROM books WHERE id = ? AND user_id = ?'),
  userBookIds: db.prepare('SELECT id FROM books WHERE user_id = ?'),
  userStoreIds: db.prepare('SELECT id FROM store_items WHERE owner_id = ?'),
  storeByBook: db.prepare('SELECT * FROM store_items WHERE book_id = ?'),
  storeItem: db.prepare('SELECT * FROM store_items WHERE id = ?'),
  deleteStoreItem: db.prepare('DELETE FROM store_items WHERE id = ?'),
  unlinkStoreCopies: db.prepare('UPDATE books SET store_id = NULL WHERE store_id = ?'),
  upsertReview: db.prepare(`INSERT INTO store_reviews (store_id, user_id, rating, title, body, author_name, created_at, updated_at)
    VALUES (@store_id, @user_id, @rating, @title, @body, @author_name, @now, @now)
    ON CONFLICT (store_id, user_id) DO UPDATE SET rating = excluded.rating, title = excluded.title,
      body = excluded.body, author_name = excluded.author_name, updated_at = excluded.updated_at`),
  deleteReview: db.prepare('DELETE FROM store_reviews WHERE store_id = ? AND user_id = ?'),
  storeReviews: db.prepare(`SELECT user_id, rating, title, body, author_name, created_at, updated_at
    FROM store_reviews WHERE store_id = ? ORDER BY updated_at DESC LIMIT 200`),
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
    storeId: b.store_id || null,
    visibility: b.pub_id ? 'public' : 'private',
    published: b.pub_id
      ? { storeId: b.pub_id, title: b.pub_title, author: b.pub_author, publisher: b.pub_publisher }
      : null,
  };
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
app.use(express.json({ limit: '100kb' }));
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

function auth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (token) {
    const user = q.sessionUser.get(sha256(token), Date.now());
    if (user) {
      req.user = user;
      req.tokenHash = sha256(token);
      return next();
    }
  }
  res.status(401).json({ error: 'Not signed in' });
}

setInterval(() => q.purgeSessions.run(Date.now()), 6 * 3600e3).unref();

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
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/register', rateLimit, async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const name = cleanText(req.body?.name, 80) || email.split('@')[0];
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password.length > 200) return res.status(400).json({ error: 'Password is too long.' });
  if (q.userByEmail.get(email)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const id = newId();
  q.insertUser.run(id, email, name, await bcrypt.hash(password, 12), Date.now());
  startSession(res, id);
  res.status(201).json({ user: q.userById.get(id) });
});

app.post('/api/auth/login', rateLimit, async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = q.userByEmail.get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  startSession(res, user.id);
  res.json({ user: q.userById.get(user.id) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies[COOKIE];
  if (token) q.deleteSession.run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

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
  res.json({ user: q.userById.get(req.user.id) });
});

app.delete('/api/me', auth, async (req, res) => {
  const full = q.userByEmail.get(req.user.email);
  if (!(await bcrypt.compare(String(req.body?.password || ''), full.password_hash))) {
    return res.status(400).json({ error: 'Password is incorrect.' });
  }
  for (const { id } of q.userBookIds.all(req.user.id)) removeBookFiles(id);
  for (const { id } of q.userStoreIds.all(req.user.id)) { q.unlinkStoreCopies.run(id); removeStoreFiles(id); }
  q.deleteUser.run(req.user.id);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// --- books -----------------------------------------------------------------
const bookPath = (id) => path.join(BOOKS_DIR, `${id}.pdf`);
const coverPath = (id) => path.join(COVERS_DIR, `${id}.jpg`);

const storePath = (id) => path.join(STORE_DIR, `${id}.pdf`);
const storeCoverPath = (id) => path.join(STORE_DIR, `${id}.jpg`);

function removeStoreFiles(id) {
  fs.rm(storePath(id), { force: true }, () => {});
  fs.rm(storeCoverPath(id), { force: true }, () => {});
}

/** Hard-link (same volume, no extra space) or copy a file. */
function linkOrCopy(from, to) {
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

function unpublish(item) {
  db.transaction(() => {
    q.unlinkStoreCopies.run(item.id);
    q.deleteStoreItem.run(item.id);
  })();
  removeStoreFiles(item.id);
}

function removeBookFiles(id) {
  fs.rm(bookPath(id), { force: true }, () => {});
  fs.rm(coverPath(id), { force: true }, () => {});
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
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_UPLOAD_MB} MB.` : 'Upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!pdf) { cleanup(); return res.status(400).json({ error: 'No PDF file was provided.' }); }
    // The %PDF header may be preceded by a little junk, which readers tolerate.
    if (!readHead(pdf.path, 1024).includes(Buffer.from('%PDF-'))) {
      cleanup();
      return res.status(400).json({ error: 'That file is not a valid PDF.' });
    }
    let hasCover = false;
    if (cover) {
      const head = readHead(cover.path, 3);
      hasCover = cover.size < 5 * 1024 * 1024 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    }

    const id = newId();
    const originalName = cleanText(pdf.originalname, 255) || 'book.pdf';
    const fallbackTitle = originalName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
    try {
      fs.renameSync(pdf.path, bookPath(id));
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
    } catch (e) {
      console.error(e);
      cleanup();
      removeBookFiles(id);
      return res.status(500).json({ error: 'Could not save the book.' });
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
  if (req.body.reset) sets.push('current_page = 1', 'last_opened_at = NULL');
  if (sets.length) {
    vals.now = Date.now();
    db.prepare(`UPDATE books SET ${sets.join(', ')}, updated_at = @now WHERE id = @id AND user_id = @user_id`)
      .run({ ...vals, id: book.id, user_id: req.user.id });
  }
  res.json({ book: publicBook(q.getBook.get(book.id, req.user.id)) });
});

app.delete('/api/books/:id', auth, (req, res) => {
  const item = q.storeByBook.get(req.params.id);
  if (item && item.owner_id === req.user.id) unpublish(item);
  const result = q.deleteBook.run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Book not found.' });
  removeBookFiles(req.params.id);
  res.json({ ok: true });
});

app.get('/api/books/:id/file', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.sendFile(bookPath(book.id), { headers: { 'Content-Type': 'application/pdf' } }, (err) => {
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
function syncStoreReview(book, user) {
  if (!book.store_id || !q.storeItem.get(book.store_id)) return;
  if (book.rating == null) q.deleteReview.run(book.store_id, user.id);
  else {
    q.upsertReview.run({
      store_id: book.store_id, user_id: user.id, rating: book.rating, title: book.review_title,
      body: book.review_body, author_name: user.name, now: Date.now(),
    });
  }
}

app.put('/api/books/:id/review', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const rating = Number(req.body?.rating);
  // 1.0 – 5.0 in half-star steps.
  if (!(rating >= 1 && rating <= 5) || Math.round(rating * 2) !== rating * 2) {
    return res.status(400).json({ error: 'Rating must be between 1.0 and 5.0 stars, in half-star steps.' });
  }
  db.prepare(`UPDATE books SET rating = ?, review_title = ?, review_body = ?, reviewed_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?`).run(rating, cleanText(req.body.title, 120), cleanMultiline(req.body.body, 5000),
    Date.now(), Date.now(), book.id, req.user.id);
  const updated = q.getBook.get(book.id, req.user.id);
  syncStoreReview(updated, req.user);
  res.json({ book: publicBook(updated) });
});

app.delete('/api/books/:id/review', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  db.prepare(`UPDATE books SET rating = NULL, review_title = '', review_body = '', reviewed_at = NULL
    WHERE id = ? AND user_id = ?`).run(book.id, req.user.id);
  const updated = q.getBook.get(book.id, req.user.id);
  syncStoreReview(updated, req.user);
  res.json({ book: publicBook(updated) });
});

// --- publishing to the Book Store ------------------------------------------
app.put('/api/books/:id/publish', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const title = cleanText(req.body?.title, 200);
  const author = cleanText(req.body?.author, 200);
  const publisher = cleanText(req.body?.publisher, 80);
  if (!title) return res.status(400).json({ error: 'Give the book a name for the Book Store.' });
  if (!publisher) return res.status(400).json({ error: 'Enter the account name to publish as.' });
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Confirm that you have the right to share this book publicly.' });
  }
  const now = Date.now();
  let item = q.storeByBook.get(book.id);
  if (item && item.owner_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  // A copy added from the store can't be re-published as someone else's.
  if (!item && book.store_id && q.storeItem.get(book.store_id)) {
    return res.status(400).json({ error: 'This book came from the Book Store, so it is already public.' });
  }
  if (item) {
    db.prepare('UPDATE store_items SET title = ?, author = ?, publisher = ?, updated_at = ? WHERE id = ?')
      .run(title, author, publisher, now, item.id);
  } else {
    const id = newId();
    try {
      linkOrCopy(bookPath(book.id), storePath(id));
      if (book.has_cover) linkOrCopy(coverPath(book.id), storeCoverPath(id));
    } catch (e) {
      console.error(e);
      removeStoreFiles(id);
      return res.status(500).json({ error: 'Could not publish the book.' });
    }
    db.prepare(`INSERT INTO store_items (id, owner_id, book_id, title, author, publisher, page_count, size, has_cover, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, book.id, title, author, publisher, book.page_count, book.size, book.has_cover, now, now);
    db.prepare('UPDATE books SET store_id = ? WHERE id = ?').run(id, book.id);
    item = q.storeItem.get(id);
  }
  // The owner's rating (if any) is published with the book.
  syncStoreReview(q.getBook.get(book.id, req.user.id), req.user);
  res.json({ book: publicBook(q.getBook.get(book.id, req.user.id)) });
});

app.delete('/api/books/:id/publish', auth, (req, res) => {
  const book = q.getBook.get(req.params.id, req.user.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const item = q.storeByBook.get(book.id);
  if (item && item.owner_id === req.user.id) unpublish(item);
  res.json({ book: publicBook(q.getBook.get(book.id, req.user.id)) });
});

// --- Book Store --------------------------------------------------------------
function publicStoreItem(s, userId) {
  return {
    id: s.id,
    title: s.title,
    author: s.author,
    publisher: s.publisher,
    pageCount: s.page_count,
    size: s.size,
    hasCover: !!s.has_cover,
    downloads: s.downloads,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    rating: s.avg_rating == null ? null : Math.round(s.avg_rating * 10) / 10,
    reviewCount: s.review_count || 0,
    mine: s.owner_id === userId,
    libraryBookId: s.library_book_id || null,
  };
}

const STORE_SELECT = `SELECT s.*,
    (SELECT AVG(rating) FROM store_reviews r WHERE r.store_id = s.id) AS avg_rating,
    (SELECT COUNT(*) FROM store_reviews r WHERE r.store_id = s.id) AS review_count,
    (SELECT b.id FROM books b WHERE b.store_id = s.id AND b.user_id = @user ORDER BY b.created_at LIMIT 1) AS library_book_id
  FROM store_items s`;
const STORE_SORTS = {
  new: 's.created_at DESC',
  rating: 'avg_rating IS NULL, avg_rating DESC, review_count DESC',
  popular: 's.downloads DESC, s.created_at DESC',
  title: 's.title COLLATE NOCASE ASC',
};

app.get('/api/store', auth, (req, res) => {
  const search = cleanText(req.query.q, 100);
  const sort = STORE_SORTS[req.query.sort] || STORE_SORTS.new;
  const like = `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = db.prepare(`${STORE_SELECT}
    WHERE (@q = '' OR s.title LIKE @like ESCAPE '\\' OR s.author LIKE @like ESCAPE '\\' OR s.publisher LIKE @like ESCAPE '\\')
    ORDER BY ${sort} LIMIT 300`).all({ user: req.user.id, q: search, like });
  res.json({ items: rows.map((r) => publicStoreItem(r, req.user.id)) });
});

app.get('/api/store/:id', auth, (req, res) => {
  const row = db.prepare(`${STORE_SELECT} WHERE s.id = @id`).get({ user: req.user.id, id: req.params.id });
  if (!row) return res.status(404).json({ error: 'This book is no longer in the Book Store.' });
  const reviews = q.storeReviews.all(row.id).map((r) => ({
    rating: r.rating, title: r.title, body: r.body, author: r.author_name,
    mine: r.user_id === req.user.id, isPublisher: r.user_id === row.owner_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
  res.json({ item: publicStoreItem(row, req.user.id), reviews });
});

app.get('/api/store/:id/cover', auth, (req, res) => {
  const item = q.storeItem.get(req.params.id);
  if (!item || !item.has_cover) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(storeCoverPath(item.id), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// Add a store book to your own library (your own copy, with your own progress and review).
app.post('/api/store/:id/library', auth, (req, res) => {
  const item = q.storeItem.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'This book is no longer in the Book Store.' });
  const existing = db.prepare('SELECT id FROM books WHERE store_id = ? AND user_id = ?').get(item.id, req.user.id);
  if (existing) return res.json({ book: publicBook(q.getBook.get(existing.id, req.user.id)) });
  const id = newId();
  try {
    linkOrCopy(storePath(item.id), bookPath(id));
    if (item.has_cover) linkOrCopy(storeCoverPath(item.id), coverPath(id));
  } catch (e) {
    console.error(e);
    removeBookFiles(id);
    return res.status(500).json({ error: 'Could not add the book.' });
  }
  db.transaction(() => {
    q.insertBook.run({
      id, user_id: req.user.id, title: item.title, author: item.author, original_name: `${item.title}.pdf`,
      size: item.size, page_count: item.page_count, has_cover: item.has_cover, now: Date.now(),
    });
    db.prepare('UPDATE books SET store_id = ? WHERE id = ?').run(item.id, id);
    db.prepare('UPDATE store_items SET downloads = downloads + 1 WHERE id = ?').run(item.id);
  })();
  res.status(201).json({ book: publicBook(q.getBook.get(id, req.user.id)) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- static front-end ------------------------------------------------------
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_DIR = path.join(PDFJS_ROOT, 'legacy', 'build');
const setMjs = (res, file) => {
  if (file.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
};
app.use('/vendor/pdfjs', express.static(PDFJS_DIR, { maxAge: '30d', setHeaders: setMjs }));
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
