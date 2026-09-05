export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Separate backend page
    if (url.pathname === "/backend" || url.pathname === "/backend/") {
      return env.ASSETS.fetch(new Request(new URL("/backend.html", url.origin), request));
    }

    // Public config API
    if (url.pathname === "/api/config" && request.method === "GET") {
      return getConfig(env);
    }

    // Save page/social configuration
    if (url.pathname === "/api/config" && request.method === "POST") {
      return saveConfig(request, env);
    }

    // Media API
    if (url.pathname.startsWith("/api/media/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/media/".length));
      if (!key || key.includes("..") || /[^a-zA-Z0-9_\-\/]/.test(key)) return new Response("Bad media key", {status:400});
      if (request.method === "GET") return getMedia(env, key);
      if (request.method === "POST") return saveMedia(request, env, key);
      if (request.method === "DELETE") return deleteMedia(env, key);
    }

    return env.ASSETS.fetch(request);
  }
};

const CONFIG_KEY = "site-config-v2";

async function getConfig(env) {
  if (!env.SOCIALHUB_DATA) return json({ok:false, storage:false, error:"KV non collegato"}, 503);
  const raw = await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  const config = raw ? JSON.parse(raw) : {page:{}, socials:{}, updatedAt:0, media:{}};
  config.media = config.media || {};
  return json({ok:true, storage:true, config});
}

async function saveConfig(request, env) {
  if (!env.SOCIALHUB_DATA) return json({ok:false, storage:false, error:"KV non collegato"}, 503);
  try {
    const body = await request.json();
    const config = { page: body.page || {}, socials: body.socials || {}, media: body.media || {}, updatedAt: Date.now() };
    await env.SOCIALHUB_DATA.put(CONFIG_KEY, JSON.stringify(config));
    return json({ok:true, storage:true, config});
  } catch (e) {
    return json({ok:false,error:e.message},400);
  }
}

async function getMedia(env, key) {
  if (!env.SOCIALHUB_DATA) return new Response("KV non collegato", {status:503});
  const raw = await env.SOCIALHUB_DATA.get("media:" + key);
  if (!raw) return new Response("Not found", {status:404});
  try {
    const media = JSON.parse(raw);
    const b64 = String(media.dataUrl || "").split(",")[1] || "";
    const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Response(binary, {headers:{"Content-Type":media.mime || "application/octet-stream", "Cache-Control":"no-store"}});
  } catch (e) {
    return new Response("Invalid media", {status:500});
  }
}

async function saveMedia(request, env, key) {
  if (!env.SOCIALHUB_DATA) return json({ok:false,storage:false,error:"KV non collegato"},503);
  try {
    const body = await request.json();
    const dataUrl = String(body.dataUrl || "");
    const mime = String(body.mime || "");
    if (!/^data:image\/(png|jpeg|webp);base64,/i.test(dataUrl)) return json({ok:false,error:"Formato immagine non supportato"},400);
    const b64 = dataUrl.split(",")[1] || "";
    if (b64.length > 11_000_000) return json({ok:false,error:"Immagine troppo grande"},413);
    await env.SOCIALHUB_DATA.put("media:" + key, JSON.stringify({dataUrl, mime, updatedAt:Date.now()}));
    return json({ok:true, url:`/api/media/${encodeURIComponent(key)}?v=${Date.now()}`});
  } catch (e) {
    return json({ok:false,error:e.message},400);
  }
}

async function deleteMedia(env, key) {
  if (!env.SOCIALHUB_DATA) return json({ok:false,storage:false,error:"KV non collegato"},503);
  await env.SOCIALHUB_DATA.delete("media:" + key);
  return json({ok:true});
}

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
