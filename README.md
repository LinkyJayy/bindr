# Bindr

A cloud PDF library with a realistic, Apple Books–style **curl** page turn.
Installable as a PWA and ready to deploy on Railway.

- **E-reader style interface.** A clean black-and-white look inspired by e-ink readers. The Home page has a search bar, a ⋮ menu (Sync, Add Books, Ratings & Reviews, Settings, Help), quick settings under the clock (Dark Mode, Sync, Add Books, All Settings), a "Jump Back In" card and shelves of your books. The Library has All / Reading / Unread / Finished / Rated filters, sorting, and grid or list view, and the bottom bar holds Home, the book you last read, and Library.
- **Accounts.** Email/password sign-up with secure, httpOnly session cookies and bcrypt-hashed passwords. No email service is needed. Every account gets a 6-digit **recovery code**, shown when it's created and any time in Settings → Recovery Code. **Forgot password?** on the sign-in screen takes the email and that code to set a new password, signs out other devices and replaces the code. Five wrong codes lock resets for that account for an hour, so codes can't be guessed.
- **Cloud library.** Uploaded PDFs, covers and reading progress are stored on the server, so they follow you to every device.
- **Library Style.** Settings → Library Style turns the Library's grid into a **Bookshelf** (covers standing on wooden shelves) or a **Bookstore** (face-out display shelves under a section sign, like "Now Reading" or "New Arrivals", with a label under each book showing its title and rating or progress). **Standard** is the plain grid. The shelves resize to fit the screen, and the ⋮ on each cover opens the book's menu.
- **Upload.** Use the **+** button, or drag and drop PDF or **ePUB** files onto the window. Bindr reads each book's title, author and cover before uploading. ePUBs are laid out by Bindr's own text engine, so the page curl, highlights, read-aloud, dark pages and the dictionary all work with them.
- **Custom names.** You choose each book's title and author before it uploads. Change them any time with **••• → Rename / Edit Details**.
- **Page curl.** A WebGL shader rolls the page over a cylinder, with lighting, the mirrored print showing through the back, and shadows. Drag from any edge or corner, flick, tap the left or right third of the page, or use the arrow keys, Space or the scroll wheel.
- **Two-page spreads.** Landscape tablets and wide screens show facing pages like an open book, with the cover on its own, sized as large as possible while the whole spread stays on screen. The page curls across the spine onto the facing page. The book button in the reader's top bar switches between one and two pages.
- **Zoom.** Double-tap a page (or press Z) to switch between fitting the whole page or spread on screen and fitting the width; when zoomed, scroll vertically.
- **Dark pages, per book.** In the reader's **Aa** panel (Themes), or a book's ⋮ menu, choose Light or Dark pages for that book. Dark recolors the page background and text, while colored text keeps its hue and pictures are left exactly as they are. The choice is saved with the book in your account, so it follows it to every device.
- **Color filters (app-wide).** Grayscale, Vibrant, Dull, Colorblind (corrections for Protanopia, Deuteranopia and Tritanopia, plus high-contrast grayscale for Achromatopsia) or Custom. One setting for the whole app and every book, in Settings or the Color tab of the reader's **Aa** panel. Highlights keep their colors in Grayscale and Achromatopsia.
- **E-ink mode.** Makes the whole screen look like an e-ink reader: neutral grays on warm paper, a limited set of gray shades, a fine paper grain, and a quick black-and-white refresh flash every 6 pages like a Kindle. Turn it on from the E-ink tile in quick settings (under the clock), or choose E-ink under Color Filter. Highlights keep their colors. Under **Screen**, choose **Black & White** (like a Kindle Paperwhite) or **Colorsoft**: soft, muted color with the fine grain of a color e-ink panel, like a Kindle Colorsoft, on slightly darker paper; there, highlights show in muted color too. The E-ink options also have a **Warmth** slider (cool gray to warm cream paper) and a **Disable flash** toggle.
- **Highlights & notes.** Press and hold a word, drag to select more, and pick Yellow, Blue, Pink or Orange. Tap a highlight to recolor it, add a note, copy it or delete it. Find them all under ⋮ → Notes & Highlights. Highlights are saved to your account. On PDFs they need a text layer (not image-only scans). To remove highlights quickly, tap the **eraser** in the reader's top bar, then tap any highlighted text (Undo is right there; swipes still turn pages).
- **Dictionary.** Double-tap a word for its definition (from the free dictionaryapi.dev, cached by the server; needs an internet connection). Double-tap empty space to zoom instead.
- **Page turn animation.** Curl, Slide or Instant, from Aa → Layout or Settings.
- **Font size.** Aa → Font resizes and reflows ePUB text. PDFs have a fixed layout, so use zoom for them.
- **Chapters & progress.** The bottom-right corner shows the current page and how many pages are left in the chapter. Tap it to switch to the whole book. Chapters come from the book's table of contents, and you can add your own under ⋮ → Chapters.
- **Ratings & reviews.** Double-tap or press and hold a book (or use ••• → Rate & Review) to give it 1.0–5.0 stars in half-star steps, with a review title and text. The rating shows on the book in your library. Tick **Share in the Book Store** to show the review to everyone.
- **Book Store.** ⋮ → Book Store lists the books people rated and shared, one entry per book, with the average rating and every shared review (reviewer's name, stars, title, text and date). It only shows each book's title, author(s) and cover: book files are never shared, so Bindr doesn't redistribute anyone's books. **Copy** gives "Book Name by Author" to paste into Amazon, Libby, a library app or any bookstore. Search and sort by recent, top rated, most reviewed or title. The owner can remove a review from the store.
- **Read aloud.** Tap the microphone in the reader to listen to the book, using the device's built-in voices. The sentence being read is captioned and highlighted on the page, and pages turn by themselves as reading continues. You can pause, skip back or forward a sentence, change the speed (0.75×–2×) and pick a voice. It needs a PDF with real text; scanned image-only PDFs have nothing to read.
- **About page.** ⋮ → About shows a page written in Markdown (headings, bold, italic, lists, quotes, links, images, code). Everyone can read it. Only the owner account (`ADMIN_EMAILS`) can edit it, with a formatting toolbar and a live preview, after a one-time **owner check** (see below).
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

## Owner check

Anyone can sign up with any email address, so being signed in as an `ADMIN_EMAILS` address isn't enough to edit the About page. The first time, tap **Confirm Owner to Edit** on the About page: Bindr writes a 6-digit **owner code** to the server log, and only whoever runs the server can read that log (Railway → your service → Deployments → View Logs, look for "Owner code"). Enter it in the app and the account can edit from then on.

If someone else signed up with the owner's address first, choose **Forgot password?**, enter the address, tap **Run this server? Use an owner code**, and use the code from the log as the code. That resets the password, confirms the account as the owner, signs everyone else out and replaces the recovery code.
