# Deploying Reading Room for free

Reading Room is one Node.js process: it serves the website, the API and the live Socket.IO connection. It needs:

- a host that supports **WebSockets**,
- somewhere **persistent** to keep the database and uploaded books,
- **HTTPS**, so Discord sign-in and secure cookies work.

There are two good free setups:

| | **A. Render + Turso** | **B. Oracle Cloud VM** |
| --- | --- | --- |
| Effort | ~15 minutes, all in the browser | ~45 minutes, some terminal work |
| Credit card | Not needed | Needed for identity check (Always Free resources are not charged) |
| Always on | No. Sleeps after 15 minutes without visitors; the first visit after that takes about a minute | Yes |
| Storage | Turso free database (5 GB): data, chat and books | The VM's own disk (up to 200 GB) |
| Updates | Automatic on every push to GitHub | `git pull` + one command |

Free-tier limits change from time to time, so check the providers' pricing pages before you rely on exact numbers.

Both setups need a Discord application first.

---

## 1. Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it your club's name.
2. Go to **OAuth2**:
   - Copy the **Client ID**.
   - Click **Reset Secret** and copy the **Client Secret**. Keep it private.
   - Under **Redirects**, add `https://YOUR-SITE/auth/discord/callback`. You'll know the exact address after step 2 (A or B); come back and add it then. For local development also add `http://localhost:5173/auth/discord/callback`.
3. You do **not** need a bot.
4. Turn on **Developer Mode** in Discord (User Settings → Advanced) so you can copy IDs:
   - Right-click your own name → **Copy User ID**. Put it in `ADMIN_USER_IDS` to become a site admin with owner rights in every room. You can then add more admins from the site (account menu → **Site admins**). Several IDs can be comma-separated.
   - Optional: right-click a server icon → **Copy Server ID** and put it in `DISCORD_GUILD_IDS` to allow only members of that server (comma-separate several servers). Leave it empty to let anyone with a Discord account sign in.
   - Optional, only together with `DISCORD_GUILD_IDS`: Server Settings → Roles → right-click a role → **Copy Role ID** for `DISCORD_ADMIN_ROLE_IDS`. People with that role are admins too.

Without `DISCORD_GUILD_IDS`, sign-in only asks Discord for the `identify` scope. With it, the app also asks for `guilds.members.read` to check membership and roles. In both cases the Discord token is revoked right after sign-in.

---

## 2A. Render (web app) + Turso (database)

Render's free web services have no persistent disk: anything written to local files is lost when the service restarts or goes to sleep. That's why this setup keeps everything in a free Turso database. With a remote `DATABASE_URL`, book files are stored in the database too, split into small chunks (`STORAGE_DRIVER=auto`).

### Create the Turso database

1. Sign up at [turso.tech](https://turso.tech) (GitHub sign-in works).
2. Create a database (e.g. `reading-room`) in the region closest to the Render region you'll pick (Frankfurt ↔ EU, Virginia/Ohio ↔ US East, and so on).
3. On the database page, copy its URL. It looks like `libsql://reading-room-yourname.turso.io`.
4. Create a database token (**Create Token** on the database page, or `turso db tokens create reading-room` with the CLI) and copy it.

### Deploy on Render

1. Push this repository to your GitHub account (it already contains `render.yaml`).
2. Sign up at [render.com](https://render.com) with GitHub.
3. Click **New → Blueprint**, pick the repository and confirm. Render reads `render.yaml` and asks for these values:

   | Key | Value |
   | --- | --- |
   | `DISCORD_CLIENT_ID` | from step 1 |
   | `DISCORD_CLIENT_SECRET` | from step 1 |
   | `ADMIN_USER_IDS` | your Discord user ID (site admin everywhere) |
   | `DISCORD_GUILD_IDS` | optional: server IDs whose members may sign in (empty = anyone) |
   | `DISCORD_ADMIN_ROLE_IDS` | optional, comma-separated role IDs |
   | `OXFORD_APP_ID`, `OXFORD_APP_KEY` | optional: Oxford Dictionaries API keys for word definitions |
   | `DATABASE_URL` | `libsql://…turso.io` |
   | `DATABASE_AUTH_TOKEN` | the Turso token |

   `SESSION_SECRET` is generated for you. `PUBLIC_URL` isn't needed: the app uses Render's own URL automatically.

   Prefer clicking through it yourself? Use **New → Web Service** with build command `npm ci --include=dev && npm run build`, start command `npm start`, instance type **Free**, and the same environment variables plus `NODE_ENV=production` and a random `SESSION_SECRET`.
4. Wait for the first deploy, then open the URL Render shows (e.g. `https://reading-room-ab12.onrender.com`). The startup log prints the exact Discord redirect URI.
5. Add `https://reading-room-ab12.onrender.com/auth/discord/callback` under **OAuth2 → Redirects** in the Discord portal and save.
6. Sign in, create a room and share the link in your server.

### Things to know about the free tier

- **Sleeping.** After 15 minutes without HTTP requests or WebSocket messages, the service sleeps. The next visitor waits about a minute while it wakes up; the page says "the server may be waking up" and you can simply retry. Open the site a few minutes before your session starts.
- **Staying awake (optional).** A free uptime monitor (for example cron-job.org or UptimeRobot) that requests `https://YOUR-SITE/healthz` every 10–14 minutes keeps it awake. One service running all month uses about 744 of the 750 free instance hours, so only do this for one service.
- **Upload size.** `render.yaml` sets `MAX_UPLOAD_MB=50`. Books are stored in Turso, whose free plan has 5 GB of storage.
- **Bandwidth.** Every member downloads the book once per session (the browser caches it afterwards). Keep an eye on Render's bandwidth allowance if you share very large PDFs.

---

## 2B. Oracle Cloud "Always Free" VM (always on)

### Create the VM

1. Sign up for [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/). Choose your **home region** carefully: Always Free resources only exist there.
2. Go to **Compute → Instances → Create instance**:
   - Image: **Ubuntu 24.04**.
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM; 1 OCPU and 6 GB RAM is plenty) or **VM.Standard.E2.1.Micro** (AMD, 1 GB RAM). If A1 says "out of capacity", try again later or use the Micro shape.
   - Add your SSH public key and create the instance. Note its **public IP**.
3. Open the web ports. In the instance's **Virtual Cloud Network → Security List**, add ingress rules for TCP **80** and **443** from `0.0.0.0/0`.
4. Oracle's Ubuntu images also have their own firewall. SSH in (`ssh ubuntu@PUBLIC_IP`) and run:

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   ```

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   ```

   ```bash
   sudo netfilter-persistent save
   ```

### Get a free domain name

If you don't own a domain, sign in at [duckdns.org](https://www.duckdns.org), create a subdomain such as `ourbookclub.duckdns.org`, and point it at the VM's public IP.

### Install and start

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker $USER && newgrp docker
```

```bash
git clone https://github.com/YOUR-ACCOUNT/discord-book-reading.git && cd discord-book-reading
```

```bash
cp .env.example .env && nano .env
```

In `.env`, set at least:

```ini
DOMAIN=ourbookclub.duckdns.org
PUBLIC_URL=https://ourbookclub.duckdns.org
SESSION_SECRET=<output of: openssl rand -hex 32>
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
ADMIN_USER_IDS=<your Discord user ID>
```

Then start it:

```bash
docker compose up -d --build
```

Caddy gets a Let's Encrypt certificate automatically. Add `https://ourbookclub.duckdns.org/auth/discord/callback` as a redirect in the Discord portal and you're live.

On the 1 GB Micro shape, the build can run out of memory. Adding 2 GB of swap fixes that:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

### Updating and backups

```bash
git pull && docker compose up -d --build
```

Everything (database and books) lives in the `app-data` Docker volume. To back it up:

```bash
docker run --rm -v discord-book-reading_app-data:/data -v "$PWD":/backup busybox tar czf /backup/reading-room-backup.tgz -C /data .
```

---

## Word definitions

Selecting a word in a book shows its meaning. It works out of the box with no setup:

1. **Built-in WordNet** (Princeton, about 155,000 English words and phrases) ships with the app. It answers instantly, needs no internet access, and resolves inflected forms ("ran" → run, "mice" → mouse).
2. **Wiktionary** (Wikimedia's official API) is asked only for words WordNet doesn't know. Answers are cached for 30 days.
3. Every pop-up also links to the word on the free **Oxford Learner's Dictionary** website.

To show Oxford's own definitions first, sign up for the [Oxford Dictionaries API](https://developer.oxforddictionaries.com) and set `OXFORD_APP_ID` and `OXFORD_APP_KEY`. Oxford's API is paid, with a limited free trial. Answers are cached, so each word only uses your quota once. If Oxford fails (wrong key, quota used up), the built-in dictionary answers instead.

## Other options

- **Any VPS or home server.** The Docker Compose setup works anywhere Docker runs. At home, a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) can publish the site without opening router ports.
- **Without Docker.** Run `npm ci --include=dev && npm run build`, then `NODE_ENV=production npm start` behind any HTTPS reverse proxy that supports WebSockets. Set `DATA_DIR` to a persistent folder.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Discord says `Invalid OAuth2 redirect_uri` | The redirect in the Discord portal must match the one printed in the server log exactly: `https`, no trailing slash. |
| "You need to be a member of our Discord community" | `DISCORD_GUILD_IDS` is set and the person isn't in any of those servers. Empty it to let anyone in. |
| No "Site admins" item in the account menu | Your Discord user ID isn't in `ADMIN_USER_IDS`. Add it, redeploy, and reload the page. |
| A word has no definition | It's in neither WordNet nor Wiktionary (often names or rare spellings). The Oxford Learner's link still works. |
| Everyone is signed out after a restart | Set a fixed `SESSION_SECRET`. |
| Books or rooms disappear on Render | `DATABASE_URL` isn't set, so the app fell back to Render's temporary disk. |
| The site stays on "Joining room…" | The proxy in front of the app must allow WebSocket upgrades. Render and the bundled Caddy setup already do. |
| Startup fails with "No way to sign in" | Set the Discord variables, or `DEV_LOGIN=true` for a private test. |
