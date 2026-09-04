[README.md](https://github.com/user-attachments/files/31854554/README.md)
# SocialHub V5 — Full-stack single Worker

Frontend + API nello stesso Cloudflare Worker.

## Struttura
- `public/index.html`
- `public/style.css`
- `src/worker.mjs`
- `wrangler.json`

## Cloudflare bindings
- `TWITCH_CLIENT_ID` (Text)
- `TWITCH_CLIENT_SECRET` (Secret)
- `SOCIALHUB_KV` (KV namespace)

## Twitch OAuth callback
`https://socialhub-web.the-sync-fm.workers.dev/auth/twitch/callback`

## Important
The `TWITCH_CLIENT_ID` placeholder in `wrangler.json` is not intended to be committed with the real client ID. In the Cloudflare dashboard keep the actual variable there.
Deploy as a Worker with Static Assets. Cloudflare supports serving static assets and Worker logic from the same deployment.
