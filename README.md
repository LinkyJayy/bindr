# Bindr

A cloud PDF library with a realistic, Apple Books–style **curl** page turn.
Installable as a PWA and ready to deploy on Railway.

- **E-reader style interface.** A clean black-and-white look inspired by e-ink readers. The Home page has a search bar, a ⋮ menu (Sync, Add Books, Ratings & Reviews, Settings, Help), quick settings under the clock (Dark Mode, Sync, Add Books, All Settings), a "Jump Back In" card and shelves of your books. The Library has All / Reading / Unread / Finished / Rated filters, sorting, and grid or list view, and the bottom bar holds Home, the book you last read, and Library.
- **Accounts.** Email/password sign-up with secure, httpOnly session cookies and bcrypt-hashed passwords.
- **Cloud library.** Uploaded PDFs, covers and reading progress are stored on the server, so they follow you to every device.
- **Upload.** Use the **+** button, or drag and drop PDF or **ePUB** files onto the window. Bindr reads each book's title, author and cover before uploading. ePUBs are laid out by Bindr's own text engine, so the page curl, highlights, read-aloud, dark pages and the dictionary all work with them.
- **Custom names.** You choose each book's title and author before it uploads. Change them any time with **••• → Rename / Edit Details**.
- **Page curl.** A WebGL shader rolls the page over a cylinder, with lighting, the mirrored print showing through the back, and shadows. Drag from any edge or corner, flick, tap the left or right third of the page, or use the arrow keys, Space or the scroll wheel.
- **Two-page spreads.** Landscape tablets and wide screens show facing pages like an open book, with the cover on its own, sized as large as possible while the whole spread stays on screen. The page curls across the spine onto the facing page. The book button in the reader's top bar switches between one and two pages.
- **Zoom.** Double-tap a page (or press Z) to switch between fitting the whole page or spread on screen and fitting the width; when zoomed, scroll vertically.
- **Dark pages, per book.** In the reader's **Aa** panel (Themes), or a book's ⋮ menu, choose Light or Dark pages for that book. Dark recolors the page background and text, while colored text keeps its hue and pictures are left exactly as they are. The choice is saved with the book in your account, so it follows it to every device.
- **Color filters (app-wide).** Grayscale, Vibrant, Dull, Colorblind (corrections for Protanopia, Deuteranopia and Tritanopia, plus high-contrast grayscale for Achromatopsia) or Custom. One setting for the whole app and every book, in Settings or the Color tab of the reader's **Aa** panel. Highlights keep their colors in Grayscale and Achromatopsia.
- **E-ink mode.** Makes the whole screen look like an e-ink reader: neutral grays on warm paper, a limited set of gray shades, a fine paper grain, and a quick black-and-white refresh flash every 6 pages like a Kindle. Turn it on from the E-ink tile in quick settings (under the clock), or choose E-ink under Color Filter. Highlights keep their colors. The E-ink options have a **Warmth** slider (cool gray to warm cream paper) and a **Disable flash** toggle.
- **Highlights & notes.** Press and hold a word, drag to select more, and pick Yellow, Blue, Pink or Orange. Tap a highlight to recolor it, add a note, copy it or delete it. Find them all under ⋮ → Notes & Highlights. Highlights are saved to your account. On PDFs they need a text layer (not image-only scans). To remove highlights quickly, tap the **eraser** in the reader's top bar, then tap any highlighted text (Undo is right there; swipes still turn pages).
- **Dictionary.** Double-tap a word for its definition (from the free dictionaryapi.dev, cached by the server; needs an internet connection). Double-tap empty space to zoom instead.
- **Page turn animation.** Curl, Slide or Instant, from Aa → Layout or Settings.
- **Font size.** Aa → Font resizes and reflows ePUB text. PDFs have a fixed layout, so use zoom for them.
- **Chapters & progress.** The bottom-right corner shows the current page and how many pages are left in the chapter. Tap it to switch to the whole book. Chapters come from the book's table of contents, and you can add your own under ⋮ → Chapters.
- **Ratings & reviews.** Double-tap or press and hold a book (or use ••• → Rate & Review) to give it 1.0–5.0 stars in half-star steps, with a review title and text. The rating shows on the book in your library.
- **Read aloud.** Tap the microphone in the reader to listen to the book, using the device's built-in voices. The sentence being read is captioned and highlighted on the page, and pages turn by themselves as reading continues. You can pause, skip back or forward a sentence, change the speed (0.75×–2×) and pick a voice. It needs a PDF with real text; scanned image-only PDFs have nothing to read.
- **About page.** ⋮ → About shows a page written in Markdown (headings, bold, italic, lists, quotes, links, images, code). Everyone can read it; only the owner account (`ADMIN_EMAILS`) sees **Edit**, with a formatting toolbar and a live preview.
- **PWA.** Installable and works offline: the app shell is cached, and every book you have opened stays readable offline. Progress made offline syncs when you reconnect.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Data is written to `./data` unless `DATA_DIR` is set.

## Deploy on Railway

1. Create a new project from this GitHub repo. `railway.json` sets the start command and the `/api/health` health check.
2. **Attach a volume to the service with mount path `/data`.**
   Railway sets `RAILWAY_VOLUME_MOUNT_PATH` automatically, and Bindr stores its SQLite database (`bindr.db`), the PDFs (`books/`) and covers (`covers/`) there.
   Without a volume, every redeploy wipes all accounts and books.
3. Generate a public domain (Settings → Networking). It must be served over HTTPS for the PWA install to work.

Optional environment variables:

| Variable        | Default                                      | Purpose                     |
|-----------------|----------------------------------------------|-----------------------------|
| `DATA_DIR`      | `RAILWAY_VOLUME_MOUNT_PATH`, else `./data`   | Where all data is stored    |
| `MAX_UPLOAD_MB` | `300`                                        | Maximum book file size      |
| `DICTIONARY_URL`| `https://api.dictionaryapi.dev/api/v2/entries/en/` | Dictionary service (same JSON format) |
| `ADMIN_EMAILS`  | `ljmiller2389@gmail.com`                     | Comma-separated accounts allowed to edit the About page |
| `PORT`          | set by Railway                               | HTTP port                   |
