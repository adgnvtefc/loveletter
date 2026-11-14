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
account.js, shelf.js signing in, "my letters", re-reading (invite.js: the invite pop-up)
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

## Links

After sealing, **send ✉** shares one message (the share sheet on phones, copied elsewhere) with a link and the username + password. The link opens the letter straight away: the postman hands it over without asking for anything. The link carries the letter's id and key after the `#` (`…/loveletter/#open=<64 characters>`), never its name or password. Browsers never send the part after `#` anywhere, and the page removes it from the address bar as soon as it's read. Anyone with the link can open the letter, just like anyone with its name + password.

## Home

After reading, **back to home** shows the yard with the postman waiting at the gate; **summon postman** (above his head) calls him over. Tapping a letter in "my letters" calls him too.

## Accounts

Optional and invite-only: the **sign in** button (top left) shows the letters you sealed and opened while signed in, and opens any of them again without its password. Details in [docs/accounts-plan.md](docs/accounts-plan.md). On the Mac:

```sh
node server/accounts.js add <name>        # make an account (asks for its password)
node server/accounts.js password <name>   # new password, signs out everywhere
node server/accounts.js invite <name>     # let them make their own from the site, once (the pop-up shows while anyone is invited)
node server/accounts.js uninvite <name>
node server/accounts.js list
```

For testing on localhost, `?office=<port>` points the pages at a throwaway post office (`LOVELETTER_HOME=<folder> PORT=<port> npm run server`), so the real one is never touched.

## Stats

The post office reports to [catseye](https://github.com/adgnvtefc/catseye) (site `loveletter`) in the background, so catseye being down never affects a letter. The pages send nothing.

| Event | When | Data |
|---|---|---|
| `letter_sealed` | a new letter is stored | `kb` |
| `letter_opened` | someone gives the right name + password | `kb`, `hours_waiting` since it was sealed, `first` open or not |

No names, ids or contents are sent. Requests from a localhost page are marked local, so catseye leaves them out. The tile is in monitor-hub (`web/sites/loveletter/`).

## Always on

```sh
launchd/install.sh                                              # install / reinstall
launchctl kickstart -k gui/$(id -u)/com.loveletter.server       # restart after editing server.js
launchctl bootout gui/$(id -u)/com.loveletter.server            # stop
```

Log: `~/.loveletter/logs/server.log`.

## Photos

Photos are shrunk to 1280px and saved as JPEG. iPhone rotation (EXIF) is respected. HEIC works everywhere: Safari reads it directly, and other browsers load a HEIC decoder ([heic-to](https://www.npmjs.com/package/heic-to)) only when one is picked.
