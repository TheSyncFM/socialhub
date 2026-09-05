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
