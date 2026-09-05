const CONFIG_KEY = "site-config-v5";
const MEDIA_PREFIX = "media:";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_KEYS = new Set([
  "profile-avatar","profile-cover",
  "banner-instagram","banner-youtube1","banner-youtube2",
  "banner-twitch","banner-kick","banner-tiktok","banner-x"
]);
const ALLOWED_MIME = new Set(["image/png","image/jpeg","image/webp"]);

const DEFAULT_CONFIG = {
  page: { title: "TheSyncFM", bio: "Seguici su tutti i nostri canali." },
  socials: {},
  accounts: {},
  composer: { draft: "", updatedAt: 0 },
  updatedAt: 0
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/backend" || url.pathname === "/backend/") {
        return env.ASSETS.fetch(new Request(new URL("/backend.html", url.origin), request));
      }

      if (url.pathname === "/api/config" && request.method === "GET") return getConfig(env);
      if (url.pathname === "/api/config" && request.method === "POST") return saveConfig(request, env);

      if (url.pathname.startsWith("/api/accounts/connect/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/accounts/connect/".length));
        if (request.method !== "GET") return json({ ok:false, error:"Metodo non supportato" },405);
        return startAccountConnection(id, env, url);
      }
      if (url.pathname === "/api/accounts/callback/twitch" && request.method === "GET") return finishTwitchConnection(request, env, url);
      if (url.pathname.startsWith("/api/publish") && request.method === "POST") return preparePublication(request, env);

      if (url.pathname.startsWith("/api/media/")) {
        const key = decodeURIComponent(url.pathname.slice("/api/media/".length));
        if (!ALLOWED_KEYS.has(key)) return json({ ok:false, error:"Media non autorizzato" }, 400);
        if (!env.SOCIALHUB_DATA) return json({ ok:false, error:"KV SOCIALHUB_DATA non collegato al Worker." }, 503);
        if (request.method === "GET") return getMedia(env, key);
        if (request.method === "POST") return saveMedia(request, env, key);
        if (request.method === "DELETE") return deleteMedia(env, key);
        return json({ ok:false, error:"Metodo non supportato" }, 405);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ ok:false, error:error?.message || "Errore interno" }, 500);
    }
  }
};


const PLATFORM_SETUP = {
  instagram: "Instagram: puoi usare un account personale con configurazione manuale oppure un account professionale per le integrazioni API.",
  youtube1: "YouTube 1: configura le credenziali OAuth Google (GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET).",
  youtube2: "YouTube 2: usa la stessa autorizzazione Google; il backend permette di gestire due canali.",
  twitch: "Twitch: configura TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET (la tua app Twitch esistente può essere riutilizzata).",
  kick: "Kick: configura l'app OAuth/API Kick quando avremo le credenziali developer.",
  tiktok: "TikTok: configura TikTok Login Kit e gli scope user.info.stats e video.publish.",
  x: "X: l'API attuale è pay-per-use, quindi viene lasciata disattivata per rispettare il requisito €0."
};

async function startAccountConnection(id, env, url){
  const allowed = ["instagram","youtube1","youtube2","twitch","kick","tiktok","x"];
  if(!allowed.includes(id)) return json({ok:false,error:"Account non riconosciuto"},400);
  if(id === "x") return json({ok:false,error:PLATFORM_SETUP.x},402);
  if(id === "instagram") return json({ok:false,error:"Instagram è configurabile dal pannello: scegli Personale per inserire manualmente profilo e link, oppure Professionale per predisporre il collegamento API."},409);
  if(id === "twitch"){
    if(!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return json({ok:false,error:PLATFORM_SETUP.twitch},503);
    const state = crypto.randomUUID();
    await env.SOCIALHUB_DATA.put("oauth:twitch:state", JSON.stringify({state, createdAt:Date.now()}), {expirationTtl:600});
    const redirect = `${url.origin}/api/accounts/callback/twitch`;
    const oauth = new URL("https://id.twitch.tv/oauth2/authorize");
    oauth.searchParams.set("client_id", env.TWITCH_CLIENT_ID);
    oauth.searchParams.set("redirect_uri", redirect);
    oauth.searchParams.set("response_type","code");
    oauth.searchParams.set("scope","user:read:email moderator:read:followers channel:read:subscriptions");
    oauth.searchParams.set("state",state);
    return json({ok:true,ready:true,url:oauth.toString(),message:"Apro Twitch per autorizzare l'account."});
  }
  return json({ok:false,error:PLATFORM_SETUP[id]},503);
}


async function finishTwitchConnection(request, env, url){
  if(!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return new Response("Credenziali Twitch non configurate",{status:503});
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const storedRaw = await env.SOCIALHUB_DATA.get("oauth:twitch:state");
  const stored = storedRaw ? JSON.parse(storedRaw) : null;
  if(!state || !code || !stored || stored.state !== state) return new Response("Stato OAuth non valido",{status:400});
  const tokenResp = await fetch("https://id.twitch.tv/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env.TWITCH_CLIENT_ID,client_secret:env.TWITCH_CLIENT_SECRET,code,grant_type:"authorization_code",redirect_uri:`${url.origin}/api/accounts/callback/twitch`})});
  const token = await tokenResp.json();
  if(!tokenResp.ok || !token.access_token) return new Response(`Errore Twitch OAuth: ${token.message||"token non ottenuto"}`,{status:502});
  const headers={"Authorization":`Bearer ${token.access_token}`,"Client-Id":env.TWITCH_CLIENT_ID};
  const uResp=await fetch("https://api.twitch.tv/helix/users",{headers});
  const uData=await uResp.json();
  const user=uData.data?.[0];
  if(!uResp.ok || !user) return new Response("Profilo Twitch non recuperato",{status:502});
  const fResp=await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(user.id)}`,{headers});
  const fData=await fResp.json();
  const sResp=await fetch(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${encodeURIComponent(user.id)}`,{headers});
  const sData=await sResp.json();
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};
  config.accounts.twitch={connected:true,handle:user.login||user.display_name,followerLabel:"Follower",followerValue:String(fData.total??0),subscriberLabel:"Abbonati",subscriberValue:String(sData.total??0),lastSync:Date.now()};
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  await env.SOCIALHUB_DATA.put("oauth:twitch:token",JSON.stringify({accessToken:token.access_token,refreshToken:token.refresh_token,expiresIn:token.expires_in,scope:token.scope,updatedAt:Date.now()}));
  return new Response(`<html><body style="font-family:system-ui;background:#0c0f15;color:#fff;padding:40px"><h2>Twitch collegato ✓</h2><p>Account: ${escapeHtml(user.display_name||user.login)}</p><p>Puoi chiudere questa finestra e tornare al backend.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`,{headers:{"content-type":"text/html; charset=utf-8"}});
}
function escapeHtml(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}

async function preparePublication(request, env){
  if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
  const body = await request.json();
  const text = String(body?.text || "").trim().slice(0,10000);
  const targets = Array.isArray(body?.targets) ? body.targets.filter(x=>["instagram","youtube1","youtube2","twitch","kick","tiktok","x"].includes(x)) : [];
  const raw = await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  let config = raw ? JSON.parse(raw) : structuredClone(DEFAULT_CONFIG);
  config.composer = {...DEFAULT_CONFIG.composer,...(config.composer||{}),draft:text,targets,updatedAt:Date.now()};
  await env.SOCIALHUB_DATA.put(CONFIG_KEY, JSON.stringify(config));
  const blocked = targets.filter(x=>x === "x");
  const pending = targets.filter(x=>x !== "x" && !config.accounts?.[x]?.connected);
  if(blocked.length) return json({ok:false,error:"X non disponibile nel flusso gratuito: la sua API è pay-per-use.",config},402);
  if(pending.length) return json({ok:false,error:`Account da collegare: ${pending.join(", ")}`,config},409);
  return json({ok:true,message:"Selezione validata e bozza salvata. L'invio reale verrà eseguito solo dalle integrazioni autorizzate.",config});
}

async function getConfig(env) {
  if (!env.SOCIALHUB_DATA) return json({ ok:false, storage:false, error:"KV SOCIALHUB_DATA non collegato al Worker." }, 503);
  const raw = await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  if (!raw) return json({ ok:true, storage:true, config:structuredClone(DEFAULT_CONFIG) });
  try {
    const parsed = JSON.parse(raw);
    return json({ ok:true, storage:true, config:{
      ...structuredClone(DEFAULT_CONFIG),
      ...parsed,
      page:{...DEFAULT_CONFIG.page, ...(parsed.page || {})},
      socials:parsed.socials || {},
      accounts:parsed.accounts || {},
      composer:{...DEFAULT_CONFIG.composer, ...(parsed.composer || {})}
    }});
  } catch {
    return json({ ok:true, storage:true, config:structuredClone(DEFAULT_CONFIG), warning:"Configurazione precedente non valida: ripristinati i valori sicuri." });
  }
}

async function saveConfig(request, env) {
  if (!env.SOCIALHUB_DATA) return json({ ok:false, storage:false, error:"KV SOCIALHUB_DATA non collegato al Worker." }, 503);
  const body = await request.json();
  const config = {
    page:{
      title:String(body?.page?.title || "TheSyncFM").slice(0,120),
      bio:String(body?.page?.bio || "Seguici su tutti i nostri canali.").slice(0,500)
    },
    socials:sanitizeSocials(body?.socials),
    accounts:sanitizeAccounts(body?.accounts),
    composer:{draft:String(body?.composer?.draft || "").slice(0,10000),updatedAt:Number(body?.composer?.updatedAt || 0)},
    updatedAt:Date.now()
  };
  await env.SOCIALHUB_DATA.put(CONFIG_KEY, JSON.stringify(config));
  const verify = await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  if (!verify) return json({ ok:false, error:"Salvataggio non verificato." }, 500);
  return json({ ok:true, storage:true, config });
}

function sanitizeSocials(input) {
  const allowed=["instagram","youtube1","youtube2","twitch","kick","tiktok","x"];
  const out={};
  for (const id of allowed) {
    const row=input?.[id] || {};
    out[id]={href:String(row.href || "").slice(0,1000),description:String(row.description || "").slice(0,180)};
  }
  return out;
}
function sanitizeAccounts(input) {
  const allowed=["instagram","youtube1","youtube2","twitch","kick","tiktok","x"];
  const out={};
  for (const id of allowed) {
    const row=input?.[id] || {};
    out[id]={connected:Boolean(row.connected),handle:String(row.handle || "").slice(0,120),followerLabel:String(row.followerLabel || "").slice(0,80),followerValue:String(row.followerValue || "").slice(0,50),subscriberLabel:String(row.subscriberLabel || "").slice(0,80),subscriberValue:String(row.subscriberValue || "").slice(0,50),lastSync:Number(row.lastSync || 0)};
  }
  return out;
}

async function saveMedia(request, env, key) {
  const mime=(request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return json({ok:false,error:"Formato non supportato. Usa PNG, JPG o WebP."},400);
  const len=Number(request.headers.get("content-length") || 0);
  if (len && len > MAX_IMAGE_BYTES) return json({ok:false,error:"Immagine troppo grande. Massimo 6 MB."},413);
  const body=await request.arrayBuffer();
  if (!body.byteLength) return json({ok:false,error:"File vuoto."},400);
  if (body.byteLength > MAX_IMAGE_BYTES) return json({ok:false,error:"Immagine troppo grande. Massimo 6 MB."},413);

  const version=Date.now();
  await env.SOCIALHUB_DATA.put(MEDIA_PREFIX + key, body, {
    metadata:{contentType:mime,updatedAt:version,size:body.byteLength}
  });

  const check=await env.SOCIALHUB_DATA.get(MEDIA_PREFIX + key, "arrayBuffer");
  if (!check || check.byteLength !== body.byteLength) return json({ok:false,error:"Upload scritto ma non verificato."},500);
  return json({ok:true,key,updatedAt:version,url:`/api/media/${encodeURIComponent(key)}?v=${version}`});
}

async function getMedia(env,key) {
  const result=await env.SOCIALHUB_DATA.getWithMetadata(MEDIA_PREFIX + key, "arrayBuffer");
  if (!result?.value) return new Response("Not found",{status:404,headers:{"Cache-Control":"no-store"}});
  const headers=new Headers();
  headers.set("Content-Type",result.metadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control","public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options","nosniff");
  return new Response(result.value,{status:200,headers});
}

async function deleteMedia(env,key) {
  await env.SOCIALHUB_DATA.delete(MEDIA_PREFIX + key);
  return json({ok:true,key,updatedAt:Date.now()});
}

function json(data,status=200){
  return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
}
