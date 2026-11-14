# Reading Room

Read books together with your Discord server. Instead of one person screen-sharing a PDF, everyone opens the same book in their own browser and follows the current reader page by page, while you keep talking on Discord voice.

![A reading room: the book on the left with the reader's live pointer, the reading queue on the right](docs/images/room-queue.jpg)

- **Many formats** – PDF, EPUB, plain text, Markdown and comic archives (CBZ).
- **Synced pages** – whoever is reading turns the pages (and scrolls) for everyone. Their mouse pointer shows up on PDF and comic pages, and text they select in an EPUB is highlighted for everyone, much like a screen share. Anyone can browse ahead and jump back to the reader with one click.
- **Discord sign-in** – one queue spot per Discord account, so opening more browsers or tabs doesn't get anyone extra turns. You can limit sign-in to members of your Discord server and give admin rights to a server role.
- **Reading queue** – join the line, **Finish** your turn or **Pass** it on. Readers can go back to the end of the line automatically, and a reader who disconnects is skipped after a grace period.
- **Moderation** – the person who creates the room (and uploads the book) is its owner. Owners and moderators can reorder the queue (drag and drop), hand the turn to someone, skip or pause the reader, lock or shuffle the queue, add moderators, kick or ban people, and manage the room's library.
- **Chat** – room chat with history. Turn changes are logged in the chat, and you get a sound and an optional desktop notification when it's your turn.
- **Saved progress** – each book remembers where the group stopped, so next week's session picks up from there.

![The same room with the chat open](docs/images/room-chat.jpg)

## How a session works

1. Someone creates a room, uploads a book and shares the room link in Discord.
2. People sign in with Discord and open the room. Everyone sees the same page.
3. Click **Join queue**. If nobody is reading, the first person in line starts right away.
4. The reader reads aloud on Discord voice and turns the pages. Everyone else follows automatically.
5. When they're done, the reader clicks **Finish turn**, or **Pass** if they'd rather not read. The next person in line gets the turn and a notification.

| Role | Can do |
| --- | --- |
| Member | Join or leave the queue, finish or pass their own turn, browse freely, chat, delete their own messages |
| Current reader | Turn pages and scroll for everyone, show their pointer or highlight |
| Moderator | Everything above, plus: reorder, shuffle, lock or clear the queue; make someone the reader; skip or pause the reader; kick or ban people; open, upload or delete books; change room settings; delete any message |
| Owner (room creator) | Everything above, plus: add or remove moderators, delete the room |
| Site admin (`ADMIN_USER_IDS` / `DISCORD_ADMIN_ROLE_IDS`) | Owner rights in every room |

## Quick start (local)

Requirements: Node.js 22 or newer.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. Discord isn't configured yet, so the login page offers a **developer login** where you pick any name. Open a second browser (or a private window) with a different name to try the queue.

To use Discord sign-in locally, copy `.env.example` to `.env`, fill in the Discord values (see [Discord setup](docs/DEPLOYMENT.md#1-create-the-discord-application)) and add `http://localhost:5173/auth/discord/callback` as a redirect in the Discord developer portal.

## Going live for free

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. In short:

- **Easiest:** [Render](https://render.com) free web service plus a free [Turso](https://turso.tech) database. No credit card needed; the site sleeps when nobody uses it.
- **Always on:** an Oracle Cloud "Always Free" VM with Docker Compose and automatic HTTPS (Caddy).

## Configuration

All settings are environment variables. `.env.example` has the full list with comments.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public address of the site (defaults to Render's URL on Render) |
| `SESSION_SECRET` | Random string that signs login cookies |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord OAuth application |
| `DISCORD_GUILD_ID` | Only members of this Discord server can sign in |
| `DISCORD_ADMIN_ROLE_IDS`, `ADMIN_USER_IDS` | Site-wide admins |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | SQLite file (default) or a remote libSQL/Turso database |
| `STORAGE_DRIVER` | Where book files are kept: `local` disk or the `database` (`auto` picks the database when it is remote) |
| `MAX_UPLOAD_MB`, `MAX_ROOMS_PER_USER`, `MAX_BOOKS_PER_ROOM` | Limits |
| `DEV_LOGIN` | Username-only login for testing; never enable it on a public site |

## Development

```bash
npm run dev        # server (port 3000) + Vite client (port 5173) with hot reload
npm test           # unit and integration tests (Vitest)
npm run typecheck  # TypeScript, server and client
npm run build      # production build into dist/
npm start          # run the production build
```

Project layout:

```
server/   Express + Socket.IO backend
  auth.ts       Discord OAuth, signed session cookies, developer login
  rooms.ts      live room state: presence, queue, moderation, chat
  turns.ts      pure queue/turn logic (unit tested)
  api.ts        REST endpoints: rooms, uploads, book files
  storage.ts    book files on disk or chunked into the database
  db.ts         libSQL / SQLite schema and queries
client/   React app (Vite)
  reader/       PDF (pdf.js), EPUB (epub.js), text/Markdown and CBZ readers
  room/         queue, chat, library and settings panels
shared/   types shared by both sides (socket protocol, positions)
tests/    Vitest tests, including a fake Discord API for the OAuth flow
```

### How syncing works

The server stores one position per book: a page number plus the scroll point for page-based formats, or an EPUB CFI. Only the current reader, or a moderator when nobody is reading, can change it. Everyone else's reader follows that position until they turn a page themselves; then they browse on their own until they click **Back to …**. Scroll positions are shared as "the point of the page in the middle of the screen", so people with different screen sizes see the same lines.

### Security notes

- Uploads are checked by extension and by file signature, and are limited in size. EPUB content renders in a sandboxed iframe with scripts disabled, Markdown is sanitised, and the site sends a strict Content-Security-Policy.
- Discord access tokens are only used during sign-in and are revoked right after. Sessions are HMAC-signed, HTTP-only cookies.
- State-changing requests need a custom header, which stops cross-site form posts.
- Book files are only served to signed-in users who aren't banned from the room.

## Ideas for later

- Run it as a Discord Activity inside a voice channel (Discord Embedded App SDK).
- Per-chapter reading schedules and attendance stats.
- Highlights and notes that stay with the book.

## License

MIT
