// Star ratings, reviews and publishing to the Book Store.

import { api } from './api.js';
import { esc, sheet, confirmSheet, toast } from './ui.js';

const STAR = 'M12 2.6l2.9 6 6.5.9-4.7 4.6 1.1 6.5L12 17.5l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z';

/** Read-only stars, e.g. 4.5 → ★★★★½. */
export function starsHtml(rating, size = 14) {
  let html = '';
  for (let i = 0; i < 5; i++) {
    const fill = Math.max(0, Math.min(1, (rating || 0) - i));
    html += `<span class="star" style="width:${size}px;height:${size}px">`
      + `<svg viewBox="0 0 24 24" class="star-empty"><path d="${STAR}"/></svg>`
      + `<span class="star-fill" style="width:${fill * 100}%"><svg viewBox="0 0 24 24" style="width:${size}px;height:${size}px"><path d="${STAR}"/></svg></span>`
      + '</span>';
  }
  return `<span class="stars" aria-label="${rating ? `${rating.toFixed(1)} out of 5 stars` : 'Not rated'}">${html}</span>`;
}

export const fmtRating = (r) => (r == null ? '' : Number(r).toFixed(1));

/** Interactive 1.0–5.0 star picker in half-star steps. */
function starInput(el, value, onChange) {
  const size = 38;
  let current = value || 0;
  const render = (v) => {
    el.innerHTML = starsHtml(v, size);
    el.setAttribute('aria-valuenow', String(v || 0));
    el.setAttribute('aria-valuetext', v ? `${v.toFixed(1)} stars` : 'No rating');
  };
  const fromEvent = (e) => {
    const r = el.querySelector('.stars').getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width - 0.01);
    return Math.max(1, Math.ceil((x / r.width) * 10) / 2);
  };
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-valuemin', '1');
  el.setAttribute('aria-valuemax', '5');
  el.setAttribute('aria-label', 'Rating');
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    current = fromEvent(e);
    render(current);
    onChange(current);
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging) { current = fromEvent(e); render(current); onChange(current); }
    else if (e.pointerType === 'mouse') render(fromEvent(e));
  });
  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('pointerleave', () => { if (!dragging) render(current); });
  el.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 0.5, ArrowUp: 0.5, ArrowLeft: -0.5, ArrowDown: -0.5 }[e.key];
    if (!step) return;
    e.preventDefault();
    current = Math.min(5, Math.max(1, (current || 0) + step));
    render(current);
    onChange(current);
  });
  render(current);
}

/** Rate & review a library book. Resolves with the updated book, or undefined. */
export function reviewSheet(book) {
  let rating = book.rating || 0;
  const linked = book.storeId || book.published;
  return sheet(
    `<h3>Rate & Review</h3><p class="sub">${esc(book.title)}${book.author ? ` · ${esc(book.author)}` : ''}</p>
     <form class="review-form">
       <div class="rating-row"><div class="star-input"></div><div class="rating-value">–</div></div>
       <label class="field"><span>Review title</span><input name="title" maxlength="120" placeholder="Sum it up in a few words" value="${esc(book.reviewTitle)}"></label>
       <label class="field"><span>Review</span><textarea name="body" maxlength="5000" rows="5" placeholder="What did you think?">${esc(book.reviewBody)}</textarea></label>
       <p class="hint">${linked ? 'This book is in the Book Store, so your review will appear there too.' : 'Make this book public to share your review in the Book Store.'}</p>
       <p class="form-error"></p>
       <div class="actions">
         ${book.rating ? '<button type="button" class="btn ghost danger-text" data-remove>Remove</button>' : ''}
         <button type="button" class="btn" data-cancel>Cancel</button>
         <button class="btn primary">Save</button>
       </div>
     </form>`,
    (el, close) => {
      const form = el.querySelector('form');
      const value = el.querySelector('.rating-value');
      const show = (v) => { value.textContent = v ? v.toFixed(1) : '–'; };
      starInput(el.querySelector('.star-input'), rating, (v) => { rating = v; show(v); });
      show(rating);
      el.querySelector('.star-input').focus();
      el.querySelector('[data-cancel]').onclick = () => close();
      el.querySelector('[data-remove]')?.addEventListener('click', async () => {
        try { close((await api.deleteReview(book.id)).book); } catch (ex) { el.querySelector('.form-error').textContent = ex.message; }
      });
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (!rating) { el.querySelector('.form-error').textContent = 'Tap the stars to choose a rating.'; return; }
        try {
          const { book: updated } = await api.saveReview(book.id, {
            rating, title: form.title.value.trim(), body: form.body.value.trim(),
          });
          toast(linked ? 'Review saved and shared in the Book Store.' : 'Review saved.');
          close(updated);
        } catch (ex) {
          el.querySelector('.form-error').textContent = ex.message;
        }
      };
    },
  );
}

/** Book Store fields shown when a book is made public (used in the publish and upload sheets). */
export function publishFieldsHtml(prefix, { title = '', author = '', publisher = '' }) {
  return `
    <label class="field"><span>Name in the Book Store</span><input name="${prefix}title" maxlength="200" value="${esc(title)}" required></label>
    <label class="field"><span>Writer</span><input name="${prefix}author" maxlength="200" value="${esc(author)}" placeholder="Who wrote it"></label>
    <label class="field"><span>Published by (account name shown)</span><input name="${prefix}publisher" maxlength="80" value="${esc(publisher)}" required></label>
    <label class="check"><input type="checkbox" name="${prefix}confirm"> <span>I wrote this book or have the right to share it publicly.</span></label>`;
}

export function readPublishFields(form, prefix) {
  return {
    title: form[`${prefix}title`].value.trim(),
    author: form[`${prefix}author`].value.trim(),
    publisher: form[`${prefix}publisher`].value.trim(),
    confirm: form[`${prefix}confirm`].checked,
  };
}

/** Choose Public/Private for a book. Resolves with the updated book, or undefined. */
export function publishSheet(book, user) {
  const pub = book.published;
  if (book.storeId && !pub) {
    toast('This book came from the Book Store, so it is already public there.');
    return Promise.resolve();
  }
  return sheet(
    `<h3>Book Store</h3>
     <p class="sub">${pub ? 'This book is <b>Public</b>: anyone with a Bindr account can find it and add it to their library.' : 'This book is <b>Private</b>: only you can see it.'}</p>
     <div class="seg vis-seg" role="radiogroup">
       <button type="button" class="seg-btn ${pub ? '' : 'active'}" data-vis="private">Private</button>
       <button type="button" class="seg-btn ${pub ? 'active' : ''}" data-vis="public">Public</button>
     </div>
     <form>
       <div class="pub-fields" ${pub ? '' : 'hidden'}>
         ${publishFieldsHtml('', {
           title: pub?.title || book.title, author: pub?.author ?? book.author, publisher: pub?.publisher || user.name,
         })}
         ${book.rating ? `<p class="hint">Your ${fmtRating(book.rating)}-star review will be published with it.</p>` : ''}
       </div>
       <p class="form-error"></p>
       <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>${pub ? 'Save' : 'Done'}</button></div>
     </form>`,
    (el, close) => {
      let vis = pub ? 'public' : 'private';
      const form = el.querySelector('form');
      const fields = el.querySelector('.pub-fields');
      const save = el.querySelector('[data-save]');
      if (pub) form.confirm.checked = true;
      el.querySelectorAll('[data-vis]').forEach((b) => (b.onclick = () => {
        vis = b.dataset.vis;
        el.querySelectorAll('[data-vis]').forEach((x) => x.classList.toggle('active', x === b));
        fields.hidden = vis !== 'public';
        save.textContent = vis === 'public' ? (pub ? 'Save' : 'Publish') : (pub ? 'Make Private' : 'Done');
      }));
      el.querySelector('[data-cancel]').onclick = () => close();
      form.onsubmit = async (e) => {
        e.preventDefault();
        const err = el.querySelector('.form-error');
        try {
          if (vis === 'public') {
            const f = readPublishFields(form, '');
            if (!f.confirm) { err.textContent = 'Please confirm you have the right to share this book.'; return; }
            const { book: updated } = await api.publish(book.id, f);
            toast(pub ? 'Book Store listing updated.' : 'Published to the Book Store.');
            close(updated);
          } else if (pub) {
            const ok = await confirmSheet('Make this book private?', 'It will be removed from the Book Store, along with its reviews there. People who already added it keep their copies.', 'Make Private');
            if (!ok) return;
            close((await api.unpublish(book.id)).book);
            toast('Removed from the Book Store.');
          } else {
            close();
          }
        } catch (ex) {
          err.textContent = ex.message;
        }
      };
    },
  );
}
