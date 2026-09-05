export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/backend" || url.pathname === "/backend/") {
        return env.ASSETS.fetch(new Request(new URL("/backend.html", url.origin), request));
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        return getConfig(env);
      }

      if (url.pathname === "/api/config" && request.method === "POST") {
        return saveConfig(request, env);
      }

      if (url.pathname.startsWith("/api/media/")) {
        const key = decodeURIComponent(url.pathname.slice("/api/media/".length));
        if (!isMediaKeyValid(key)) return json({ ok: false, error: "Chiave media non valida" }, 400);
        if (request.method === "GET") return getMedia(env, key);
        if (request.method === "POST") return saveMedia(request, env, key);
        if (request.method === "DELETE") return deleteMedia(env, key);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ ok: false, error: error?.message || "Errore interno" }, 500);
    }
  }
};

const CONFIG_KEY = "site-config-v3";
const MEDIA_PREFIX = "media:";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const DEFAULT_CONFIG = {
  page: { title: "TheSyncFM", bio: "Seguici su tutti i nostri canali." },
  socials: {},
  accounts: {},
  composer: { draft: "", updatedAt: 0 },
  media: {},
  updatedAt: 0
};

function isMediaKeyValid(key) {
  return /^[a-zA-Z0-9_-]+$/.test(key) && key.length <= 80;
}

async function getConfig(env) {
  if (!env.SOCIALHUB_DATA) return json({ ok: false, storage: false, error: "KV non collegato" }, 503);
  const raw = await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  let config = structuredClone(DEFAULT_CONFIG);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      config = {
        ...config,
        ...parsed,
        page: { ...config.page, ...(parsed.page || {}) },
        socials: parsed.socials || {},
        accounts: parsed.accounts || {},
        composer: { ...config.composer, ...(parsed.composer || {}) },
        media: parsed.media || {}
      };
    } catch {
      // Keep safe defaults if an old/corrupt config is encountered.
    }
  }
  return json({ ok: true, storage: true, config });
}

async function saveConfig(request, env) {
  if (!env.SOCIALHUB_DATA) return json({ ok: false, storage: false, error: "KV non collegato" }, 503);
  const body = await request.json();
  const config = {
    page: {
      title: String(body?.page?.title || "TheSyncFM").slice(0, 120),
      bio: String(body?.page?.bio || "Seguici su tutti i nostri canali.").slice(0, 300)
    },
    socials: sanitizeSocials(body?.socials),
    accounts: sanitizeAccounts(body?.accounts),
    composer: {
      draft: String(body?.composer?.draft || "").slice(0, 5000),
      updatedAt: Number(body?.composer?.updatedAt || 0)
    },
    media: sanitizeMediaMeta(body?.media),
    updatedAt: Date.now()
  };
  await env.SOCIALHUB_DATA.put(CONFIG_KEY, JSON.stringify(config));
  return json({ ok: true, storage: true, config });
}

function sanitizeSocials(input) {
  const allowed = ["instagram", "youtube1", "youtube2", "twitch", "kick", "tiktok", "x"];
  const out = {};
  for (const id of allowed) {
    const row = input?.[id] || {};
    out[id] = {
      href: String(row.href || "").slice(0, 1000),
      description: String(row.description || "").slice(0, 180)
    };
  }
  return out;
}

function sanitizeAccounts(input) {
  const allowed = ["instagram", "youtube1", "youtube2", "twitch", "kick", "tiktok", "x"];
  const out = {};
  for (const id of allowed) {
    const row = input?.[id] || {};
    out[id] = {
      connected: Boolean(row.connected),
      handle: String(row.handle || "").slice(0, 120),
      followerLabel: String(row.followerLabel || "").slice(0, 80),
      followerValue: String(row.followerValue || "").slice(0, 50),
      subscriberLabel: String(row.subscriberLabel || "").slice(0, 80),
      subscriberValue: String(row.subscriberValue || "").slice(0, 50),
      lastSync: Number(row.lastSync || 0)
    };
  }
  return out;
}

function sanitizeMediaMeta(input) {
  const allowed = ["profile-avatar", "profile-cover", "banner-instagram", "banner-youtube1", "banner-youtube2", "banner-twitch", "banner-kick", "banner-tiktok", "banner-x"];
  const out = {};
  for (const key of allowed) {
    if (input?.[key]) out[key] = { updatedAt: Number(input[key].updatedAt || Date.now()) };
  }
  return out;
}

async function getMedia(env, key) {
  if (!env.SOCIALHUB_DATA) return new Response("KV non collegato", { status: 503 });
  const value = await env.SOCIALHUB_DATA.get(MEDIA_PREFIX + key, { type: "arrayBuffer", cacheTtl: 0 });
  if (!value) return new Response("Not found", { status: 404 });
  const metadata = await env.SOCIALHUB_DATA.get(MEDIA_PREFIX + key + ":meta", "json");
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.mime || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function saveMedia(request, env, key) {
  if (!env.SOCIALHUB_DATA) return json({ ok: false, storage: false, error: "KV non collegato" }, 503);
  const contentType = request.headers.get("content-type") || "";
  let mime = contentType.split(";")[0].trim().toLowerCase();
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) {
    return json({ ok: false, error: "Formato immagine non supportato. Usa PNG, JPG o WebP." }, 400);
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength && contentLength > MAX_IMAGE_BYTES) return json({ ok: false, error: "Immagine troppo grande. Massimo 6 MB." }, 413);
  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) return json({ ok: false, error: "Immagine troppo grande. Massimo 6 MB." }, 413);

  await env.SOCIALHUB_DATA.put(MEDIA_PREFIX + key, buffer, { metadata: { mime, updatedAt: Date.now() } });
  const updatedAt = Date.now();
  await env.SOCIALHUB_DATA.put(MEDIA_PREFIX + key + ":meta", JSON.stringify({ mime, updatedAt }));
  return json({ ok: true, key, updatedAt, url: `/api/media/${encodeURIComponent(key)}?v=${updatedAt}` });
}

async function deleteMedia(env, key) {
  if (!env.SOCIALHUB_DATA) return json({ ok: false, storage: false, error: "KV non collegato" }, 503);
  await env.SOCIALHUB_DATA.delete(MEDIA_PREFIX + key);
  await env.SOCIALHUB_DATA.delete(MEDIA_PREFIX + key + ":meta");
  return json({ ok: true, key, updatedAt: Date.now() });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
