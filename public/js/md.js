// A small, safe Markdown renderer for the About page.
//
// Everything is HTML-escaped first, so text can never inject markup or scripts;
// only the Markdown constructs below produce HTML. Links and images must be
// http(s) (links may also be mailto:).
//
// Supported: # headings, paragraphs, **bold**, *italic*, ~~strikethrough~~,
// `code`, ``` code blocks ```, [links](https://…), ![images](https://…),
// - / * / 1. lists (one level of nesting), > quotes, --- rules,
// line breaks (two trailing spaces or a backslash), and bare https:// URLs.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeUrl(url, { image = false } = {}) {
  const u = url.trim().replace(/&amp;/g, '&');
  if (/^https?:\/\//i.test(u) || (!image && /^mailto:/i.test(u))) return esc(u);
  return null;
}

function inline(text) {
  // Code spans first (their content is left alone), via placeholders.
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const u = safeUrl(url, { image: true });
    return u ? `<img src="${u}" alt="${alt}" loading="lazy">` : m;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = safeUrl(url);
    return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  // Bare URLs (not already inside an attribute or link).
  s = s.replace(/(^|[\s(])(https?:\/\/(?:(?!&quot;|&#39;)[^\s<])*(?:(?!&quot;|&#39;)[^\s<.,;:!?)]))/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)|(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g,
    (m, p1, a, p2, b) => (a !== undefined ? `${p1}<em>${a}</em>` : `${p2}<em>${b}</em>`));
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/( {2,}|\\)\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join('\n'))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Fenced code block
    if (/^\s*```/.test(line)) {
      flushPara();
      const body = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      flushPara();
      const n = m[1].length;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out.push('<hr>'); continue; }
    if (/^\s*>/.test(line)) {
      flushPara();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const indent = lines[i].match(/^\s*/)[0].length;
        // A top-level item of the other kind (bullet vs number) starts a new list.
        if (indent < 2 && items.length && /^\s*\d/.test(lines[i]) !== ordered) break;
        const text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        if (indent >= 2 && items.length) items[items.length - 1].sub.push(text);
        else items.push({ text, sub: [] });
        i++;
      }
      i--;
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.text)}${it.sub.length ? `<ul>${it.sub.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</${tag}>`);
      continue;
    }
    para.push(line);
  }
  flushPara();
  return out.join('\n');
}
