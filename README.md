# H2Whose? — v1.1

The fairest way to find the next bottle-filler. Now with shared state, sound effects, confetti, and a Hall of Hydration.

## What's new in 1.1

- **Shared state across everyone** — backed by Upstash Redis. Spins on one device show up on every other device in ~5 seconds.
- **Offline-resilient** — if the API is unreachable, the app falls back to `localStorage` and syncs back up when it's online again.
- **Decelerating roulette spin** — starts fast, dramatic slow-down at the end.
- **Canvas confetti** on every reveal.
- **5 procedural sound effects** (Web Audio API — no audio files, no bundle bloat). Mute toggle in the header.
- **Hall of Hydration** — top 3 fillers by count, shown above the Splash Log.
- **🔥 Back-to-back badge** — the log flags anyone picked twice in a row.
- **Room codes via URL hash** — `/#finance`, `/#team-a`, etc. Each room gets its own isolated state, so different teams share one deployment without clashing.
- **Sync status pill** — green = synced, red = offline, amber = syncing.

## Deploy in 5 steps

### 1. Push this code to GitHub

Replace the contents of your `PushpakHota/H2whose` repo with the files in this zip. Structure should look like:

```
/
├── api/
│   └── state.js
├── src/
│   ├── App.jsx
│   ├── confetti.js
│   ├── main.jsx
│   └── sounds.js
├── index.html
├── package.json
├── vercel.json        (optional — Vercel auto-detects everything)
└── vite.config.js
```

### 2. Push — Vercel will auto-deploy (and fail with a Redis error)

That's expected. The build will succeed but the app will show "offline" because Redis isn't configured yet. On to step 3.

### 3. Add the Upstash Redis integration

In your Vercel project dashboard:

1. **Storage** tab → **Create Database** (or "Browse Marketplace").
2. Pick **Upstash** → **Redis**.
3. Name it anything (e.g. `h2whose-kv`). Pick the region closest to you (for Bhubaneswar, choose `ap-south-1 / Mumbai` if offered — otherwise Singapore).
4. Click **Create** and then **Connect to Project** → select the H2whose project.

Vercel will automatically inject the credentials as environment variables (`KV_REST_API_URL` + `KV_REST_API_TOKEN`). You don't need to copy anything manually.

### 4. Redeploy

Vercel → Deployments → the most recent one → **⋯ menu** → **Redeploy**. This picks up the new env vars.

### 5. Open the app

The sync pill in the top-right should turn green and say "synced". Try it:

- Open the app on your laptop, add a name.
- Open the same URL on your phone — the name should appear within ~5 seconds.
- Hit "pick a buddy" on one device and watch the other device pick up the result on the next poll.

## Using rooms (optional)

Different teams can share one deployment without stepping on each other. Just stick a hash on the URL:

- `https://your-app.vercel.app/#finance`
- `https://your-app.vercel.app/#marketing`
- `https://your-app.vercel.app/#csm-bd`

Each room has totally separate state. The room code shows up as a little tag under the title when it's not `default`.

## Notes

- **History cap:** 300 entries on the client, 500 on the server, to keep requests small.
- **Polling interval:** 5 seconds. Paused while a spin is in progress or the tab is backgrounded.
- **Audio:** sounds only start playing after your first click on the page (browser autoplay rules).
- **Cost:** Upstash free tier gives 10,000 commands/day — way more than this app will ever use. No credit card needed.
