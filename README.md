# Bindr

A cloud PDF library with a realistic, Apple Books–style **curl** page turn.
Installable as a PWA and ready to deploy on Railway.

- **Accounts.** Email/password sign-up with secure, httpOnly session cookies and bcrypt-hashed passwords.
- **Cloud library.** Uploaded PDFs, covers and reading progress are stored on the server, so they follow you to every device.
- **Upload.** Use the **+** button, or drag and drop PDFs onto the library. Bindr reads each PDF's title, author and first page (for the cover) before uploading.
- **Custom names.** You choose each book's title and author before it uploads. Change them any time with **••• → Rename / Edit Details**.
- **Page curl.** A WebGL shader rolls the page over a cylinder, with lighting, the mirrored print showing through the back, and shadows. Drag from any edge or corner, flick, tap the left or right third of the page, or use the arrow keys, Space or the scroll wheel.
- **Two-page spreads.** Landscape tablets and wide screens show facing pages like an open book, with the cover on its own. The page curls across the spine onto the facing page. The book button in the reader's top bar switches between one and two pages.
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
| `MAX_UPLOAD_MB` | `300`                                        | Maximum PDF size            |
| `PORT`          | set by Railway                               | HTTP port                   |
