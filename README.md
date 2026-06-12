# ⛽ Cheap Gas Near Me

A small live web app that shows the **lowest gas prices in your city and the
surrounding area** (anywhere in Canada — or beyond). On open it **auto-detects
your location** and searches it immediately; you can also search any city by
name. Pick a fuel grade and radius and get a ranked list + map of the cheapest
stations. Prices auto-refresh every 10 minutes, and in "near me" mode the app
re-checks your position on each refresh, so it follows you as you move.

No frameworks — plain Node.js plus a single dependency (`web-push`) for
price-alert notifications.

## Run it

```powershell
npm install   # first time only
node server.js
```

Open **http://localhost:3000**.

Out of the box it runs in **mock mode** (realistic sample data, clearly
labelled) so you can try the whole app immediately. Real prices need a free
Google API key — steps below.

## Get real prices (free Google API key, ~10 minutes)

The price data comes from Google's **Places API (New)** — the same fuel prices
you see on gas stations in Google Maps, which covers Canada well. Setup:

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. You'll be asked to set up **billing** (credit card required). The app is
   designed to stay inside the free tier — see the cost-control section below.
3. In **APIs & Services → Library**, search for **“Places API (New)”** and
   click **Enable**. (It must be the *(New)* one — the legacy Places API has
   no fuel prices.)
4. In **APIs & Services → Credentials**, click **Create credentials → API
   key**. Recommended: edit the key and under *API restrictions* restrict it
   to *Places API (New)* only.
5. Copy `config.example.json` to `config.json` and paste your key in
   `googleMapsApiKey`. (Or set `$env:GOOGLE_MAPS_API_KEY` instead.)
6. Restart the server. The yellow “sample data” banner disappears and you're
   on live prices.

`config.json` is gitignored, so your key never ends up in version control.

## How it stays free

Requests that include fuel prices bill under Google's **Enterprise** SKU,
which (as of 2026) includes **1,000 free calls per month**; after that it's
pay-per-call, so the app protects you three ways:

- **Server-side cache** — results for an area are reused for 30 minutes
  (`cacheMinutes` in config). Refreshing the page costs nothing extra.
- **Daily call budget** — hard cap of `maxGoogleCallsPerDay` (default **30**,
  i.e. ≤ ~930/month). When it's hit, the app serves cached data and tells you,
  instead of spending money.
- **On-demand fetching only** — nothing polls in the background on the server;
  Google is only called when you actually look at an area with a stale cache.

A 5–10 km search = 1 Google call; 25 km = 5; 50 km = 7 (wider areas need
several sample circles because each call returns at most 20 stations). With
the default budget you can comfortably check prices several times a day,
every day, for $0. You can double-check usage anytime in Google Cloud Console
→ *APIs & Services → Places API (New) → Metrics*, and optionally set a budget
alert in the Billing section for extra peace of mind.

## Use it on your phone

The app is a PWA (installable web app):

1. Make sure your phone is on the same Wi-Fi as this PC.
2. Find the PC's address: `ipconfig` → IPv4 Address (e.g. `192.168.1.42`).
3. On the phone, open `http://192.168.1.42:3000` and use your browser's
   **Add to Home Screen** — it then opens full-screen like a native app.
   (If it doesn't load, allow Node.js through Windows Defender Firewall when
   prompted, or add an inbound rule for port 3000.)

**About location detection:** browsers only allow precise GPS on secure
(`https://`) pages, and `http://192.168.x.x:3000` isn't one. The app handles
this automatically: when GPS isn't available it falls back to your network's
IP location (city-level, marked "approx." in the app) — on home Wi-Fi that's
normally your city, which is plenty to find the cheap stations. Precise GPS
works on `http://localhost` (desktop) and anywhere the app is served over
HTTPS.

## Deploy it (HTTPS + precise GPS + works anywhere)

The repo ships with a [render.yaml](render.yaml) blueprint for Render's free
tier:

1. Push this folder to a GitHub repository.
2. Go to <https://dashboard.render.com> → **New → Blueprint**, pick the repo.
3. When prompted, paste your Google API key as `GOOGLE_MAPS_API_KEY`.
4. Deploy. You get a permanent `https://cheap-gas-….onrender.com` URL.

Open that URL on your phone → allow location → **Add to Home Screen**. With
HTTPS the app uses real GPS and follows you as you move between towns.

Free-tier notes: the service spins down after ~15 idle minutes, so the first
open after a quiet spell takes ~30–60 s to wake (subsequent loads are
instant). The daily API budget guard runs server-side, so even if someone
else finds your URL they can't push you past the free Google tier — the app
just serves cached prices once the cap is hit. The `data/usage.json` counter
resets on redeploys, which at worst lets a deploy-day exceed the soft daily
cap — the monthly math still leaves lots of headroom.

## Price alerts (optional, ~10 minutes of setup)

The app can push a notification when the cheapest fuel near you hits your
target (Settings → *Price alert*). Three pieces make it work:

1. **VAPID keys** (the server's notification signing keys). Locally they're
   already in `config.json`. For the deployed app: Render dashboard →
   *cheap-gas* service → **Environment** → add `VAPID_PUBLIC_KEY` and
   `VAPID_PRIVATE_KEY` with the values from your local `config.json` → Save
   (it redeploys itself). To make fresh keys later:
   `node -e "console.log(require('web-push').generateVAPIDKeys())"`.
2. **A scheduled ping.** The server checks alerts when something calls
   `/api/alerts/run` (it self-throttles to every 20 min, so over-pinging is
   harmless). Create a free monitor at <https://uptimerobot.com> (or a free
   cron at <https://cron-job.org>) that hits
   `https://YOUR-APP.onrender.com/api/alerts/run` every **20–30 minutes**.
   Bonus: this also keeps the free instance awake, which one service can
   afford within Render's free 750 instance-hours/month.
3. **Enable it in the app** on the device that should get notified: Settings →
   set your ¢/L target → flip the switch → allow notifications.
   **iPhone:** notifications only work from the home-screen-installed app
   (iOS 16.4+), not from a Safari tab — install first, then enable.

Reliability fine print: Render's free tier resets the server's stored
subscriptions when it redeploys or restarts. The app silently re-registers
your alert every time you open it, so in practice alerts keep working as long
as you open the app now and then. You get at most one alert per day per
device.

## Accounts & cross-device sync (optional)

Zen-Garden-style accounts: the app silently creates an anonymous account on
first visit (random id + device token — no email, no password, no sign-up
screen). Favourites, brand filter, settings, fill-up logbook, and price-alert
subscriptions then sync through a MariaDB/MySQL database. To pair a phone:
Settings → **Link another device** → enter the 6-digit code on the phone.

Setup: run `setup-db.local.sql` against your database server once, then give
the app these settings (config.json locally / environment variables on
Render): `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and
`AUTH_SECRET` (any long random hex string; tokens are derived from it, so
changing it signs every device out). Without database config the app still
works — data just stays per-device.

Housekeeping tips: keep the database port firewalled to the app server's
outbound IPs (Render lists three per service under "Connect") plus your own,
and consider enabling TLS on MariaDB if the connection crosses the internet.

## Honest limitations

- **Freshness:** Google's station prices typically update a few times per day
  (crowd/partner-sourced), not the instant the sign changes. Each price shows
  its “last updated” age so you can judge it.
- **Coverage:** the odd station reports no price for some grades — they're
  listed under “stations without a price” so you know they exist.
- Mock mode is fake data for trying the UI; don't drive to those prices. 🙂
- Station logos are fetched as website favicons via Google's favicon service;
  all brand marks remain trademarks of their respective owners. Unrecognized
  brands show a coloured-letter tile instead.

## Files

| File | What it is |
|---|---|
| `server.js` | Node server: static files, `/api/stations`, `/api/geocode`, `/api/route`, push-alert endpoints, caching, daily budget guard, mock mode |
| `public/` | The web app (Leaflet map + ranked list, PWA manifest) |
| `config.example.json` | Copy to `config.json` and add your API key |
| `data/usage.json` | Auto-created; persists today's Google-call count across restarts |
