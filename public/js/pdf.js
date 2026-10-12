// Lazily loads PDF.js (served from /vendor/pdfjs by the server).
let lib;

export async function pdfjs() {
  if (!lib) {
    lib = await import('/vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return lib;
}

export async function openPdf(data) {
  const { getDocument } = await pdfjs();
  return getDocument({
    data,
    cMapUrl: '/vendor/pdfjs-assets/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs-assets/standard_fonts/',
    isEvalSupported: false,
  }).promise;
}

/** Read title/author/page count and render a JPEG cover from a local PDF file. */
export async function inspectPdf(file) {
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
  try {
    let title = '';
    let author = '';
    try {
      const { info } = await doc.getMetadata();
      title = (info?.Title || '').trim();
      author = (info?.Author || '').trim();
    } catch {}
    // Ignore obviously auto-generated titles.
    if (/^(untitled|microsoft word|document\d*|.*\.(docx?|pdf|indd|tex))/i.test(title)) title = '';

    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 480 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const cover = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    return { title, author, pageCount: doc.numPages, cover };
  } finally {
    doc.destroy();
  }
}
