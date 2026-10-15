# Deploying Orion

Three pieces: the graph on **FalkorDB Cloud**, the API on **Railway**, the web app on **Vercel**. Each has a free
or near-free tier. Do them in this order, because each one needs the address of the one before.

## 1. FalkorDB Cloud (the graph)

1. Sign in at [app.falkordb.cloud](https://app.falkordb.cloud) and create a free instance.
2. Copy its **host**, **port**, **username** and **password**.
3. Load Corvane into it from your machine:

   ```bash
   cd backend
   FALKORDB_HOST=<host> FALKORDB_PORT=<port> FALKORDB_USERNAME=<user> FALKORDB_PASSWORD=<password> \
   FALKORDB_SSL=true uv run orion reset
   ```

   (The API also loads Corvane by itself on its first start if the graph is empty.)

## 2. Railway (the API)

1. Sign in at [railway.com](https://railway.com) with GitHub, **New Project → Deploy from GitHub repo →
   `Sumit99589/orion`**.
2. In the service's **Settings**, set **Root Directory** to `backend`. Railway reads `backend/railway.json` and builds
   `backend/Dockerfile`.
3. In **Variables**, add:

   | Variable | Value |
   |---|---|
   | `FALKORDB_HOST`, `FALKORDB_PORT`, `FALKORDB_USERNAME`, `FALKORDB_PASSWORD` | from step 1 |
   | `FALKORDB_SSL` | `true` |
   | `ORION_LLM` | `anthropic` (or `gemini`) |
   | `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` | your key |
   | `ORION_SECRET` | a long random string (`python3 -c "import secrets; print(secrets.token_hex(32))"`) |
   | `ORION_CORS` | the Vercel address from step 3, e.g. `https://orion-corvane.vercel.app` (update it after step 3) |
   | `ORION_LLM_PER_HOUR` | `60` (model calls per visitor per hour) |
   | `ORION_ADMIN_TOKEN` | another random string, if you want `POST /api/corvane/reset` |
   | `GITHUB_TOKEN` | a GitHub token with public read access, for the Codebases screen |

4. **Settings → Networking → Generate Domain**. Check `https://<your-api>.up.railway.app/api/health` returns
   `{"ok": true, ...}`.

## 3. Vercel (the web app)

1. Sign in at [vercel.com](https://vercel.com) with GitHub, **Add New → Project → import `Sumit99589/orion`**.
2. Set **Root Directory** to `web`. The framework is detected as Next.js.
3. Add the environment variable `NEXT_PUBLIC_API_URL` = `https://<your-api>.up.railway.app` (from step 2), and
   `NEXT_PUBLIC_TENANT` = `corvane`.
4. Deploy, then put the Vercel address into Railway's `ORION_CORS` (step 2.3) and redeploy the API.

## Resetting the live demo

Visitors change the company (merges, live messages). To put it back:

```bash
curl -X POST https://<your-api>.up.railway.app/api/corvane/reset -H "X-Admin-Token: <ORION_ADMIN_TOKEN>"
```

## One box instead

Everything also runs on a single machine with Docker:

```bash
ANTHROPIC_API_KEY=... ORION_SECRET=... docker compose --profile full up -d --build
# web on :3001, API on :8100, FalkorDB Browser on :3000
```
