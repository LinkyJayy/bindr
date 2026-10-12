// Star ratings and reviews.

import { api } from './api.js';
import { esc, sheet, toast } from './ui.js';

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
  return sheet(
    `<h3>Rate & Review</h3><p class="sub">${esc(book.title)}${book.author ? ` · ${esc(book.author)}` : ''}</p>
     <form class="review-form">
       <div class="rating-row"><div class="star-input"></div><div class="rating-value">–</div></div>
       <label class="field"><span>Review title</span><input name="title" maxlength="120" placeholder="Sum it up in a few words" value="${esc(book.reviewTitle)}"></label>
       <label class="field"><span>Review</span><textarea name="body" maxlength="5000" rows="5" placeholder="What did you think?">${esc(book.reviewBody)}</textarea></label>
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
          toast('Review saved.');
          close(updated);
        } catch (ex) {
          el.querySelector('.form-error').textContent = ex.message;
        }
      };
    },
  );
}
