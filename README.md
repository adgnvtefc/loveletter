# loveletter

Pixel-art love letters. A postman walks up to your door, checks who it's from and the password, and hands you an envelope. Cut it open, swipe up, read.

## Run

```sh
npm run server   # the post office, http://127.0.0.1:8792, letters in ~/.loveletter
npm run site     # the pages, http://localhost:4180
npm test
```

The sample letter is from **billy**, password **hello** (it's built into the page, never stored). Write your own at http://localhost:4180/creator/.

## Files

```
index.html, app.js   reading a letter: postman → envelope → cut → read
scene.js             all the pixel art, drawn in code (street, postman, envelope)
store.js             seal / open letters: encrypts in the browser, talks to the post office
demo.js              the sample letter
creator/             writing a letter
style.css            both pages
server/              the post office (Node, no dependencies, node:sqlite)
launchd/             keeps the post office running on the Mac
```

## How letters are stored

Name + password → (in the browser) an **id** and an **encryption key**. The browser encrypts the letter and sends only the id and the encrypted bytes to the post office. It never sees names, passwords or contents. The same password works for different senders. Name and password ignore case and extra spaces.

The post office is one SQLite table, `letters (id, blob, sealed_at)`, in `~/.loveletter/letters.db`:

| | |
|---|---|
| `GET /v1/letters/<id>` | the bytes, or 404 |
| `PUT /v1/letters/<id>` | 201 stored · 409 already taken · 413 over 12 MB · 429 over 30 new letters an hour · 507 over 2 GB in total |

Only the site's own pages may call it from a browser (`https://adgnvtefc.github.io` and localhost:4180; add more with `LOVELETTER_ORIGINS`). Reads are limited to 240 a minute to slow down password guessing. A short password is still guessable, so pick a real one for real letters.

Pages on localhost use the local post office. The published site uses `https://hanmos-mac-studio.tail6c4683.ts.net/loveletter` (Tailscale Funnel → 127.0.0.1:8792).

## Always on

```sh
launchd/install.sh                                              # install / reinstall
launchctl kickstart -k gui/$(id -u)/com.loveletter.server       # restart after editing server.js
launchctl bootout gui/$(id -u)/com.loveletter.server            # stop
```

Log: `~/.loveletter/logs/server.log`.

## Photos

Photos are shrunk to 1280px and saved as JPEG. iPhone rotation (EXIF) is respected. HEIC works everywhere: Safari reads it directly, and other browsers load a HEIC decoder ([heic-to](https://www.npmjs.com/package/heic-to)) only when one is picked.
