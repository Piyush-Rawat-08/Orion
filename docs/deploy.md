# Deploying Orion

Three pieces: the graph on **FalkorDB Cloud**, the API on **Render**, the web app on **Vercel**. Each has a free
tier. Do them in this order, because each one needs the address of the one before.

Live demo: web https://orion-gamma-six.vercel.app, API https://orion-api-tk3u.onrender.com. Render's free
instances sleep after 15 minutes without traffic; the first request after that takes about a minute.

## 1. FalkorDB Cloud (the graph)

1. Sign in at [app.falkordb.cloud](https://app.falkordb.cloud) and create a free instance.
2. Copy its **host**, **port**, **username** and **password**.
3. Load Corvane into it from your machine:

   ```bash
   cd backend
   FALKORDB_HOST=<host> FALKORDB_PORT=<port> FALKORDB_USERNAME=<user> FALKORDB_PASSWORD=<password> uv run orion reset
   ```

   (The API also loads Corvane by itself on its first start if the graph is empty.) Cloud users may run graph
   commands only, which is why Orion keeps its clocks, counters and locks in a graph (`orion:meta`) rather than in
   Redis keys.

## 2. Render (the API)

`render.yaml` at the root of the repo is a blueprint for the API: one Docker web service built from `backend/`.

1. In [Render](https://dashboard.render.com): **New → Blueprint**, pick this repository.
2. Fill in the values it asks for:

   | Variable | Value |
   |---|---|
   | `FALKORDB_HOST`, `FALKORDB_PORT`, `FALKORDB_USERNAME`, `FALKORDB_PASSWORD` | from step 1 |
   | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | your keys (`ORION_LLM` picks which one answers) |
   | `GITHUB_TOKEN` | a GitHub token with public read access, for the Codebases screen |
   | `ORION_TZ` | optional: the time zone of the clock, default `Asia/Kolkata` |

   `ORION_SECRET` and `ORION_ADMIN_TOKEN` are generated; `ORION_CORS` is the Vercel address.
3. When it is live, check `https://<your-api>.onrender.com/api/health` returns `{"ok": true, ...}`.

## 3. Vercel (the web app)

1. Sign in at [vercel.com](https://vercel.com) with GitHub, **Add New → Project → import `Sumit99589/orion`**.
2. Set **Root Directory** to `web`. The framework is detected as Next.js.
3. Add the environment variable `NEXT_PUBLIC_API_URL` = `https://<your-api>.onrender.com` (from step 2), and
   `NEXT_PUBLIC_TENANT` = `corvane`. `web/vercel.json` tells Vercel the app is Next.js.
4. Deploy, then put the Vercel address into Render's `ORION_CORS` (step 2) and redeploy the API.

## Resetting the live demo

Visitors change the company (merges, live messages). To put it back:

```bash
curl -X POST https://<your-api>.onrender.com/api/corvane/reset -H "X-Admin-Token: <ORION_ADMIN_TOKEN>"
```

## One box instead

Everything also runs on a single machine with Docker:

```bash
ANTHROPIC_API_KEY=... ORION_SECRET=... docker compose --profile full up -d --build
# web on :3001, API on :8100, FalkorDB Browser on :3000
```
