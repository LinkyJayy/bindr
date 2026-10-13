// Thin wrapper around the Bindr REST API.

let needsVerificationHandler = null;
/** Called when the server says the account must verify its email first. */
export function onNeedsVerification(fn) { needsVerificationHandler = fn; }

async function request(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    const err = new Error('You appear to be offline.');
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    if (data.needsVerification) {
      err.needsVerification = true;
      needsVerificationHandler?.();
    }
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('GET', '/api/me'),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  register: (name, email, password) => request('POST', '/api/auth/register', { name, email, password }),
  logout: () => request('POST', '/api/auth/logout'),
  sendVerification: () => request('POST', '/api/auth/verify/send'),
  verifyEmail: (code) => request('POST', '/api/auth/verify', { code }),
  sendReset: (email) => request('POST', '/api/auth/reset/send', { email }),
  resetPassword: (email, code, password) => request('POST', '/api/auth/reset', { email, code, password }),
  updateMe: (fields) => request('PATCH', '/api/me', fields),
  deleteAccount: (password) => request('DELETE', '/api/me', { password }),
  books: () => request('GET', '/api/books'),
  updateBook: (id, fields) => request('PATCH', `/api/books/${encodeURIComponent(id)}`, fields),
  deleteBook: (id) => request('DELETE', `/api/books/${encodeURIComponent(id)}`),
  fileUrl: (id) => `/api/books/${encodeURIComponent(id)}/file`,
  saveReview: (id, review) => request('PUT', `/api/books/${encodeURIComponent(id)}/review`, review),
  deleteReview: (id) => request('DELETE', `/api/books/${encodeURIComponent(id)}/review`),
  highlights: (id) => request('GET', `/api/books/${encodeURIComponent(id)}/highlights`),
  addHighlight: (id, h) => request('POST', `/api/books/${encodeURIComponent(id)}/highlights`, h),
  updateHighlight: (hid, fields) => request('PATCH', `/api/highlights/${encodeURIComponent(hid)}`, fields),
  deleteHighlight: (hid) => request('DELETE', `/api/highlights/${encodeURIComponent(hid)}`),
  about: () => request('GET', '/api/about'),
  saveAbout: (content) => request('PUT', '/api/about', { content }),
  define: (word) => request('GET', `/api/define/${encodeURIComponent(word)}`),
  coverUrl: (book) => `/api/books/${encodeURIComponent(book.id)}/cover?v=${book.createdAt}`,

  /** Upload with progress reporting (fetch can't report upload progress). */
  uploadBook({ file, cover, title, author, pageCount }, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('title', title);
      form.append('author', author);
      form.append('pageCount', String(pageCount || 0));
      if (cover) form.append('cover', cover, 'cover.jpg');
      form.append('file', file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/books');
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data.book);
        else reject(new Error(data.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
      xhr.send(form);
    });
  },
};
