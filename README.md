[README.md](https://github.com/user-attachments/files/34858819/README.md)
# SocialHub TheSyncFM — V47

Base: V46. V44 e V46 originali restano conservate negli archivi precedenti.

## V47 — Market Intelligence foundation
- Aggiunta sezione privata Market Intelligence nel backend.
- Configurazione fino a 15 competitor/creator, obiettivi e criteri di confronto salvati in Cloudflare KV.
- Archivio privato dei report settimanali salvati in Cloudflare KV.
- Endpoint protetti da sessione amministratore: `/api/market/config` e `/api/market/reports`.
- Aggiunta `public/admin-login.html`, richiesta dal routing di autenticazione già presente in V46 ma assente dall'archivio V46.

IMPORTANTE: V47 è la base funzionale e di archiviazione. Non esegue ancora raccolta automatica dei trend, scansione dei competitor, generazione AI o invio programmato. Queste funzioni richiedono fonti/API e credenziali dedicate, da configurare prima di dichiararle operative.

## Cloudflare
Mantieni il binding KV `SOCIALHUB_DATA` e le variabili amministrative già configurate (`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`). Non sono richieste nuove variabili per la sola configurazione e archiviazione Market Intelligence.
