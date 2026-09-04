# SocialHub V3 — TheSyncFM

Questa versione aggiunge il collegamento personale Twitch.

## Flusso
1. L'utente clicca "Connetti Twitch".
2. Il browser va a `/auth/twitch/start` sul Cloudflare Worker.
3. Twitch gestisce l'autorizzazione.
4. Il Worker salva la sessione in KV e restituisce un session id alla pagina.
5. Il frontend salva solo il session id nel localStorage e usa `/twitch/me?session=...` per caricare i dati privati.
6. Il logout cancella la sessione KV.

## Endpoint Worker richiesti
- /auth/twitch/start
- /auth/twitch/callback
- /auth/twitch/logout
- /twitch/me?session=SESSION
- /twitch/status?login=thesyncfm

## Nota sicurezza
Il Client Secret Twitch non è presente nel frontend. La sessione è gestita dal Worker/KV.

## Deploy
Sostituire `index.html` e `style.css` nel repository GitHub `socialhub`.
