const CONFIG_KEY = "site-config-v5";
const MEDIA_PREFIX = "media:";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_KEYS = new Set([
  "profile-avatar","profile-cover",
  "banner-instagram","banner-youtube1","banner-youtube2",
  "banner-twitch","banner-kick","banner-tiktok","banner-x","banner-discord"
]);
const ALLOWED_MIME = new Set(["image/png","image/jpeg","image/webp"]);

const DEFAULT_CONFIG = {
  page: { title: "TheSyncFM", bio: "Seguici su tutti i nostri canali." },
  socials: {},
  accounts: {},
  composer: { draft: "", updatedAt: 0 },
  updatedAt: 0
};

const ADMIN_COOKIE = "socialhub_admin";
const ADMIN_MAX_AGE = 60 * 60 * 24; // 24 ore; la sessione della scheda viene inoltre gestita da sessionStorage.

function b64url(bytes){
  let s=""; for(const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");
}
function unb64url(input){
  const s=String(input||"").replaceAll("-","+").replaceAll("_","/");
  const pad="=".repeat((4-(s.length%4))%4);
  const bin=atob(s+pad);
  const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
async function adminKey(env){
  const secret=String(env.ADMIN_PASSWORD||"");
  return crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}
function getAdminCookie(request){
  const raw=request.headers.get("Cookie")||"";
  for(const part of raw.split(";")){
    const [k,...rest]=part.trim().split("=");
    if(k===ADMIN_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}
async function createAdminToken(env){
  const payload=`${Date.now()}.${crypto.randomUUID()}`;
  const sig=await crypto.subtle.sign("HMAC",await adminKey(env),new TextEncoder().encode(payload));
  return `${b64url(new TextEncoder().encode(payload))}.${b64url(new Uint8Array(sig))}`;
}
async function isAdminAuthenticated(request,env){
  try{
    if(!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) return false;
    const token=getAdminCookie(request);
    if(!token) return false;
    const parts=token.split(".");
    if(parts.length!==2) return false;
    const payload=new TextDecoder().decode(unb64url(parts[0]));
    const created=Number(payload.split(".")[0]);
    if(!Number.isFinite(created)) return false;
    const age=Date.now()-created;
    if(age< -60000 || age>ADMIN_MAX_AGE*1000) return false;
    return await crypto.subtle.verify("HMAC",await adminKey(env),unb64url(parts[1]),new TextEncoder().encode(payload));
  }catch{return false}
}
function setAdminCookie(token){
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${ADMIN_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}
function clearAdminCookies(){
  return [
    `${ADMIN_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`,
    `${ADMIN_COOKIE}=; Path=/backend; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`
  ];
}
function noCacheHeaders(headers){
  headers.set("Cache-Control","no-store, no-cache, must-revalidate, max-age=0");
  headers.set("Pragma","no-cache");
  headers.set("Expires","0");
  headers.set("Vary","Cookie");
  return headers;
}
async function logoutResponse(origin){
  const headers=noCacheHeaders(new Headers());
  headers.set("Location",`${origin}/admin-login.html?logged_out=${Date.now()}`);
  for(const cookie of clearAdminCookies()) headers.append("Set-Cookie",cookie);
  return new Response(null,{status:303,headers});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        if(!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD){
          return json({ok:false,error:"ADMIN_USERNAME e/o ADMIN_PASSWORD non configurati nel Worker."},503);
        }
        const body=await request.json().catch(()=>({}));
        const username=String(body?.username??"").trim();
        const password=String(body?.password??"");
        const configuredUsername=String(env.ADMIN_USERNAME??"").trim();
        const configuredPassword=String(env.ADMIN_PASSWORD??"");
        if(!configuredUsername || !configuredPassword){
          return json({ok:false,error:"Credenziali admin non configurate nel Worker. Verifica ADMIN_USERNAME e ADMIN_PASSWORD."},503);
        }
        // Ignora solo eventuali spazi/ritorni a capo accidentali inseriti nei valori Cloudflare.
        const passwordMatches = password === configuredPassword || password === configuredPassword.trim();
        if(username!==configuredUsername || !passwordMatches){
          return json({ok:false,error:"Username o password non corretti."},401);
        }
        const token=await createAdminToken(env);
        const headers=noCacheHeaders(new Headers({"Content-Type":"application/json; charset=utf-8"}));
        headers.set("Set-Cookie",setAdminCookie(token));
        return new Response(JSON.stringify({ok:true,message:"Login corretto."}),{status:200,headers});
      }
      if (url.pathname === "/api/admin/logout" && (request.method === "POST" || request.method === "GET")) {
        return logoutResponse(url.origin);
      }
      if (url.pathname === "/backend" || url.pathname === "/backend/" || url.pathname === "/backend.html") {
        const ok=await isAdminAuthenticated(request,env);
        const target=ok ? "/backend.html" : "/admin-login.html";
        const response=await env.ASSETS.fetch(new Request(new URL(target,url.origin),request));
        const headers=noCacheHeaders(new Headers(response.headers));
        return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
      }

      // TikTok URL-prefix verification file (required by TikTok Developer Portal).
      if (url.pathname === "/tiktokZFDbQnbb6mU6qZneMnB8H5xo39iQlmRk.txt" && request.method === "GET") {
        return new Response("tiktok-developers-site-verification=ZFDbQnbb6mU6qZneMnB8H5xo39iQlmRk", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" }
        });
      }

      // La configurazione di lettura resta pubblica per la pagina pubblica.
      if (url.pathname === "/api/config" && request.method === "GET") return getConfig(env);

      // Tutte le operazioni amministrative richiedono login. Le callback OAuth e i GET dei media restano pubblici.
      const publicCallback = url.pathname === "/api/accounts/callback/twitch" || url.pathname === "/api/accounts/callback/youtube" || url.pathname === "/api/accounts/callback/instagram" || url.pathname === "/api/accounts/callback/tiktok" || url.pathname === "/api/accounts/youtube/select";
      const publicMediaGet = url.pathname.startsWith("/api/media/") && request.method === "GET";
      const adminApi = url.pathname.startsWith("/api/") && url.pathname !== "/api/config" && !publicCallback && !publicMediaGet;
      if(adminApi && !(await isAdminAuthenticated(request,env))) return json({ok:false,error:"Accesso amministratore richiesto."},401);
      if (url.pathname === "/api/config" && request.method === "POST") return saveConfig(request, env);
      if (url.pathname === "/api/diagnostic/config" && request.method === "GET") return diagnosticConfig(env);

      if (url.pathname.startsWith("/api/accounts/connect/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/accounts/connect/".length));
        if (request.method !== "GET") return json({ ok:false, error:"Metodo non supportato" },405);
        return startAccountConnection(id, env, url);
      }
      if (url.pathname === "/api/accounts/callback/twitch" && request.method === "GET") return finishTwitchConnection(request, env, url);
      if (url.pathname === "/api/accounts/sync/twitch" && request.method === "POST") return syncTwitchAccount(env);
      if (url.pathname === "/api/accounts/disconnect/twitch" && request.method === "POST") return disconnectTwitchAccount(env);
      if (url.pathname === "/api/accounts/callback/kick" && request.method === "GET") return finishKickConnection(request, env, url);
      if (url.pathname === "/api/accounts/sync/kick" && request.method === "POST") return syncKickAccount(env);
      if (url.pathname === "/api/accounts/disconnect/kick" && request.method === "POST") return disconnectKickAccount(env);
      if (url.pathname === "/api/accounts/callback/youtube" && request.method === "GET") return finishYouTubeConnection(request, env, url);
      if (url.pathname === "/api/accounts/callback/instagram" && request.method === "GET") return finishInstagramConnection(request, env, url);
      if (url.pathname === "/api/accounts/callback/tiktok" && request.method === "GET") return finishTikTokConnection(request, env, url);
      if (url.pathname === "/api/accounts/youtube/select" && request.method === "GET") return selectYouTubeChannel(request, env, url);
      if (url.pathname.startsWith("/api/accounts/sync/youtube") && request.method === "POST") {
        const slot = decodeURIComponent(url.pathname.slice("/api/accounts/sync/youtube/".length));
        return syncYouTubeAccount(env, slot);
      }
      if (url.pathname.startsWith("/api/accounts/disconnect/youtube") && request.method === "POST") {
        const slot = decodeURIComponent(url.pathname.slice("/api/accounts/disconnect/youtube/".length));
        return disconnectYouTubeAccount(env, slot);
      }
      if (url.pathname === "/api/accounts/sync/instagram" && request.method === "POST") return syncInstagramAccount(env);
      if (url.pathname === "/api/accounts/disconnect/instagram" && request.method === "POST") return disconnectInstagramAccount(env);
      if (url.pathname === "/api/accounts/sync/tiktok" && request.method === "POST") return syncTikTokAccount(env);
      if (url.pathname === "/api/accounts/disconnect/tiktok" && request.method === "POST") return disconnectTikTokAccount(env);
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


async function diagnosticConfig(env){
  return json({
    ok:true,
    checks:{
      twitchClientId:Boolean(env.TWITCH_CLIENT_ID),
      twitchClientSecret:Boolean(env.TWITCH_CLIENT_SECRET),
      googleClientId:Boolean(env.GOOGLE_CLIENT_ID),
      googleClientSecret:Boolean(env.GOOGLE_CLIENT_SECRET),
      metaAppId:Boolean(env.META_APP_ID || env.INSTAGRAM_APP_ID),
      metaAppSecret:Boolean(env.META_APP_SECRET || env.INSTAGRAM_APP_SECRET),
      instagramOAuthToken:Boolean(env.INSTAGRAM_ACCESS_TOKEN),
      tiktokClientKey:Boolean(env.TIKTOK_CLIENT_KEY),
      tiktokClientSecret:Boolean(env.TIKTOK_CLIENT_SECRET),
      kv:Boolean(env.SOCIALHUB_DATA),
      assets:Boolean(env.ASSETS)
    },
    timestamp:Date.now()
  });
}


function bytesToBase64Url(bytes){
  let binary="";
  for(const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");
}
function base64UrlToBytes(input){
  const s=String(input||"").replaceAll("-","+").replaceAll("_","/");
  const pad="=".repeat((4-(s.length%4))%4);
  const bin=atob(s+pad);
  const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
async function hmacState(env,payload){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.GOOGLE_CLIENT_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(payload)));
  return bytesToBase64Url(sig);
}
async function makeYouTubeState(env,slot){
  const payload=`${slot}.${Date.now()}.${crypto.randomUUID()}`;
  const sig=await hmacState(env,payload);
  return `${bytesToBase64Url(new TextEncoder().encode(payload))}.${sig}`;
}
async function verifyYouTubeState(env,token){
  try{
    const parts=String(token||"").split(".");
    if(parts.length<2) return null;
    const sig=parts.pop();
    const payloadB64=parts.join(".");
    const payload=new TextDecoder().decode(base64UrlToBytes(payloadB64));
    const expected=await hmacState(env,payload);
    const a=base64UrlToBytes(sig), b=base64UrlToBytes(expected);
    if(a.length!==b.length) return null;
    let diff=0; for(let i=0;i<a.length;i++) diff|=a[i]^b[i];
    if(diff!==0) return null;
    const parts2=payload.split(".");
    const slot=parts2[0], created=Number(parts2[1]);
    if(!["youtube1","youtube2"].includes(slot) || !Number.isFinite(created)) return null;
    const age=Date.now()-created;
    if(age>10*60*1000 || age < -60*1000) return null;
    return {slot,createdAt:created};
  }catch{return null}
}
function getCookie(request,name){
  const raw=request.headers.get("Cookie")||"";
  for(const part of raw.split(";")){
    const [k,...rest]=part.trim().split("=");
    if(k===name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
function clearCookieHeader(){return "socialhub_yt_state=; Path=/api/accounts/callback/youtube; Max-Age=0; HttpOnly; Secure; SameSite=Lax"}

const INSTAGRAM_API_VERSION = "v25.0";
const INSTAGRAM_BASIC_SCOPE = "instagram_business_basic";

function instagramAppCredentials(env){
  return {
    appId: String(env.INSTAGRAM_APP_ID || env.META_APP_ID || "").trim(),
    appSecret: String(env.INSTAGRAM_APP_SECRET || env.META_APP_SECRET || "").trim()
  };
}

async function instagramApi(path, token){
  const base = `https://graph.instagram.com/${INSTAGRAM_API_VERSION}`;
  const u = new URL(base + path);
  const resp = await fetch(u.toString(), {
    headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` }
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data, status: resp.status };
}

async function instagramShortToken(env, code, redirectUri){
  const {appId, appSecret}=instagramAppCredentials(env);
  const body=new URLSearchParams({
    client_id:appId,
    client_secret:appSecret,
    grant_type:"authorization_code",
    redirect_uri:redirectUri,
    code
  });
  const resp=await fetch("https://api.instagram.com/oauth/access_token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},
    body
  });
  const data=await resp.json().catch(()=>({}));
  return {ok:resp.ok,data,status:resp.status};
}

async function instagramLongLivedToken(env, shortToken){
  const {appSecret}=instagramAppCredentials(env);
  const u=new URL(`https://graph.instagram.com/${INSTAGRAM_API_VERSION}/access_token`);
  u.searchParams.set("grant_type","ig_exchange_token");
  u.searchParams.set("client_secret",appSecret);
  u.searchParams.set("access_token",shortToken);
  const resp=await fetch(u.toString(),{headers:{"Accept":"application/json"}});
  const data=await resp.json().catch(()=>({}));
  return {ok:resp.ok,data,status:resp.status};
}

async function refreshInstagramToken(token){
  const u=new URL(`https://graph.instagram.com/${INSTAGRAM_API_VERSION}/refresh_access_token`);
  u.searchParams.set("grant_type","ig_refresh_token");
  u.searchParams.set("access_token",token);
  const resp=await fetch(u.toString(),{headers:{"Accept":"application/json"}});
  const data=await resp.json().catch(()=>({}));
  return {ok:resp.ok,data,status:resp.status};
}

function instagramError(data,status){
  return data?.error?.message || data?.error_message || data?.message || `Instagram API errore ${status}`;
}

async function instagramState(env){
  if(!env.SOCIALHUB_DATA) throw new Error("KV SOCIALHUB_DATA non collegato al Worker.");
  const raw=await env.SOCIALHUB_DATA.get("oauth:instagram:token");
  return raw ? JSON.parse(raw) : null;
}

async function saveInstagramToken(env, tokenData){
  const expiresIn=Number(tokenData?.expires_in || 0);
  const token=String(tokenData?.access_token || "");
  if(!token) throw new Error("Instagram non ha restituito un access token.");
  await env.SOCIALHUB_DATA.put("oauth:instagram:token",JSON.stringify({
    accessToken:token,
    tokenType:tokenData?.token_type || "bearer",
    userId:tokenData?.user_id || "",
    expiresIn,
    expiresAt:expiresIn ? Date.now()+expiresIn*1000 : 0,
    updatedAt:Date.now()
  }));
}

async function getInstagramAccessToken(env){
  const stored=await instagramState(env);
  if(stored?.accessToken){
    // Long-lived Instagram tokens can be refreshed before expiry. Keep a seven-day safety window.
    if(stored.expiresAt && stored.expiresAt < Date.now()+7*24*60*60*1000){
      const refreshed=await refreshInstagramToken(stored.accessToken);
      if(refreshed.ok && refreshed.data?.access_token){
        await saveInstagramToken(env,refreshed.data);
        const fresh=await instagramState(env);
        return {token:fresh.accessToken,source:"oauth",refreshed:true};
      }
      // If refresh fails but the token is still valid, use it and surface no false error here.
      if(stored.expiresAt > Date.now()) return {token:stored.accessToken,source:"oauth",refreshed:false};
    }
    return {token:stored.accessToken,source:"oauth",refreshed:false};
  }
  // Backward-compatible manual-token fallback for an already configured Worker.
  if(env.INSTAGRAM_ACCESS_TOKEN) return {token:String(env.INSTAGRAM_ACCESS_TOKEN),source:"manual",refreshed:false};
  return {token:"",source:"none",refreshed:false};
}

async function finishInstagramConnection(request, env, url){
  if(!env.SOCIALHUB_DATA) return new Response("KV SOCIALHUB_DATA non collegato al Worker.",{status:503});
  const state=url.searchParams.get("state")||"";
  const code=url.searchParams.get("code")||"";
  const error=url.searchParams.get("error_reason") || url.searchParams.get("error") || "";
  const errorDescription=url.searchParams.get("error_description") || "";
  const storedRaw=await env.SOCIALHUB_DATA.get("oauth:instagram:state");
  let stored=null;
  try{stored=storedRaw?JSON.parse(storedRaw):null}catch{}
  await env.SOCIALHUB_DATA.delete("oauth:instagram:state");

  if(!state || !stored || stored.state!==state){
    return Response.redirect(`${url.origin}/backend?instagram=error&message=${encodeURIComponent("Stato OAuth Instagram non valido o scaduto.")}`,303);
  }
  if(error || !code){
    const msg=errorDescription || error || "Autorizzazione Instagram annullata.";
    return Response.redirect(`${url.origin}/backend?instagram=error&message=${encodeURIComponent(msg)}`,303);
  }

  const {appId,appSecret}=instagramAppCredentials(env);
  if(!appId || !appSecret){
    return Response.redirect(`${url.origin}/backend?instagram=error&message=${encodeURIComponent("META_APP_ID/META_APP_SECRET non configurati nel Worker.")}`,303);
  }

  const redirectUri=`${url.origin}/api/accounts/callback/instagram`;
  const short=await instagramShortToken(env,code,redirectUri);
  if(!short.ok || !short.data?.access_token){
    return Response.redirect(`${url.origin}/backend?instagram=error&message=${encodeURIComponent(`Token Instagram non ottenuto: ${instagramError(short.data,short.status)}`)}`,303);
  }

  const long=await instagramLongLivedToken(env,short.data.access_token);
  if(!long.ok || !long.data?.access_token){
    return Response.redirect(`${url.origin}/backend?instagram=error&message=${encodeURIComponent(`Token Instagram a lunga durata non ottenuto: ${instagramError(long.data,long.status)}`)}`,303);
  }
  long.data.user_id=short.data.user_id || "";
  await saveInstagramToken(env,long.data);

  const synced=await syncInstagramAccount(env);
  if(!synced.ok){
    const body=await synced.text().catch(()=>"");
    let msg="Instagram autorizzato, ma sincronizzazione non riuscita.";
    try{msg=JSON.parse(body)?.error||msg}catch{}
    return Response.redirect(`${url.origin}/backend?instagram=error&message=${encodeURIComponent(msg)}`,303);
  }
  return Response.redirect(`${url.origin}/backend?instagram=connected`,303);
}

async function syncInstagramAccount(env){
  if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
  const auth=await getInstagramAccessToken(env);
  if(!auth.token) return json({ok:false,error:"Instagram: account non autorizzato. Premi Collega e completa Instagram Business Login."},503);

  const profile = await instagramApi(`/me?fields=id,user_id,username,name,profile_picture_url,followers_count,follows_count,account_type`, auth.token);
  if(!profile.ok){
    const msg = instagramError(profile.data,profile.status);
    const detail = profile.data?.error?.code ? ` (codice ${profile.data.error.code})` : "";
    return json({ok:false,error:`Instagram: ${msg}${detail}`},502);
  }

  const instagramId = profile.data?.user_id || profile.data?.id || "";
  if(!instagramId) return json({ok:false,error:"Instagram: l'API non ha restituito l'ID dell'account."},502);

  let followerValue = "—";
  let followerSource = "";
  const profileFollowers = profile.data?.followers_count;
  if(profileFollowers !== undefined && profileFollowers !== null && profileFollowers !== ""){
    const n=Number(profileFollowers);
    if(Number.isFinite(n) && n>=0){followerValue=String(n);followerSource="profile.followers_count";}
  }

  const raw = await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  const config = raw ? JSON.parse(raw) : structuredClone(DEFAULT_CONFIG);
  config.accounts = config.accounts || {};
  const previous = config.accounts.instagram || {};
  const username = profile.data?.username || previous.username || "";
  const handle = username ? `@${username}` : (previous.handle || "");
  const displayName = profile.data?.name || (username ? `@${username}` : "Instagram");
  const followingValue = profile.data?.follows_count;
  config.accounts.instagram = {
    ...previous,
    connected: true,
    accountType: profile.data?.account_type || "professional",
    username,
    handle,
    displayName,
    profileUrl: username ? `https://www.instagram.com/${encodeURIComponent(username)}/` : (previous.profileUrl || ""),
    instagramId,
    profileImage: profile.data?.profile_picture_url || previous.profileImage || "",
    followerLabel: "Follower",
    followerValue,
    followingValue: (followingValue !== undefined && followingValue !== null) ? String(followingValue) : (previous.followingValue || "—"),
    followerSource,
    lastSync: Date.now(),
    note: auth.source === "manual"
      ? "Account professionale collegato tramite token Instagram configurato manualmente."
      : "Account Business collegato tramite Instagram Business Login."
  };
  await env.SOCIALHUB_DATA.put(CONFIG_KEY, JSON.stringify(config));
  return json({ok:true,account:config.accounts.instagram,config,message:`Instagram collegato${followerValue !== "—" ? ` · ${followerValue} follower` : " · follower non disponibili"}.`});
}

async function disconnectInstagramAccount(env){
  if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
  const raw = await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  const config = raw ? JSON.parse(raw) : structuredClone(DEFAULT_CONFIG);
  config.accounts = config.accounts || {};
  const previous = config.accounts.instagram || {};
  config.accounts.instagram = {
    ...previous,
    connected: false,
    followerLabel: "Follower",
    followerValue: "—",
    lastSync: 0
  };
  await env.SOCIALHUB_DATA.put(CONFIG_KEY, JSON.stringify(config));
  return json({ok:true,config,message:"Instagram scollegato dal pannello."});
}

const PLATFORM_SETUP = {
  instagram: "Instagram: puoi usare un account personale con configurazione manuale oppure un account professionale per le integrazioni API.",
  youtube1: "YouTube 1: configura le credenziali OAuth Google (GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET).",
  youtube2: "YouTube 2: usa la stessa autorizzazione Google; il backend permette di gestire due canali.",
  twitch: "Twitch: configura TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET (la tua app Twitch esistente può essere riutilizzata).",
  kick: "Kick: collega il tuo account tramite OAuth 2.1. Servono KICK_CLIENT_ID e KICK_CLIENT_SECRET.",
  tiktok: "TikTok: configura TikTok Login Kit con TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET; per i follower serve user.info.stats.",
  x: "X: l'API attuale è pay-per-use, quindi viene lasciata disattivata per rispettare il requisito €0."
};


const TIKTOK_DEFAULT_SCOPES = ["user.info.basic","user.info.profile","user.info.stats","video.upload","video.publish"];

function tikTokScopes(env){
  const configured=String(env.TIKTOK_SCOPES || "").trim();
  const raw=configured ? configured.split(/[\s,]+/).filter(Boolean) : TIKTOK_DEFAULT_SCOPES;
  return [...new Set(raw)];
}

function tiktokError(data,status){
  return data?.error_description || data?.error?.message || data?.message || data?.error || `TikTok API errore ${status}`;
}

async function tiktokState(env){
  if(!env.SOCIALHUB_DATA) throw new Error("KV SOCIALHUB_DATA non collegato al Worker.");
  const raw=await env.SOCIALHUB_DATA.get("oauth:tiktok:token");
  return raw ? JSON.parse(raw) : null;
}

async function saveTikTokToken(env,tokenData,previous={}){
  if(!env.SOCIALHUB_DATA) throw new Error("KV SOCIALHUB_DATA non collegato al Worker.");
  const accessToken=String(tokenData?.access_token || "");
  if(!accessToken) throw new Error("TikTok non ha restituito un access token.");
  const expiresIn=Number(tokenData?.expires_in || 0);
  const refreshToken=String(tokenData?.refresh_token || previous.refreshToken || "");
  const refreshExpiresIn=Number(tokenData?.refresh_expires_in || 0);
  const openId=String(tokenData?.open_id || previous.openId || "");
  await env.SOCIALHUB_DATA.put("oauth:tiktok:token",JSON.stringify({
    accessToken,
    refreshToken,
    openId,
    scope:String(tokenData?.scope || previous.scope || ""),
    tokenType:tokenData?.token_type || previous.tokenType || "Bearer",
    expiresIn,
    expiresAt:expiresIn ? Date.now()+expiresIn*1000 : (previous.expiresAt || 0),
    refreshExpiresIn,
    refreshExpiresAt:refreshExpiresIn ? Date.now()+refreshExpiresIn*1000 : (previous.refreshExpiresAt || 0),
    updatedAt:Date.now()
  }));
}

async function tiktokTokenRequest(env,params){
  const body=new URLSearchParams({
    client_key:String(env.TIKTOK_CLIENT_KEY || "").trim(),
    client_secret:String(env.TIKTOK_CLIENT_SECRET || "").trim(),
    ...params
  });
  const resp=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache","Accept":"application/json"},
    body
  });
  const data=await resp.json().catch(()=>({}));
  return {ok:resp.ok && !data?.error,status:resp.status,data};
}

async function getTikTokAccessToken(env){
  const stored=await tiktokState(env);
  if(!stored?.accessToken) return {token:"",source:"none"};
  const now=Date.now();
  if(stored.expiresAt && stored.expiresAt <= now){
    if(!stored.refreshToken || (stored.refreshExpiresAt && stored.refreshExpiresAt <= now)) return {token:"",source:"expired"};
    const refreshed=await tiktokTokenRequest(env,{grant_type:"refresh_token",refresh_token:stored.refreshToken});
    if(refreshed.ok && refreshed.data?.access_token){
      await saveTikTokToken(env,refreshed.data,stored);
      const fresh=await tiktokState(env);
      return {token:fresh.accessToken,source:"oauth",refreshed:true};
    }
    return {token:"",source:"refresh_error",error:tiktokError(refreshed.data,refreshed.status)};
  }
  if(stored.expiresAt && stored.expiresAt <= now+60*60*1000 && stored.refreshToken){
    const refreshed=await tiktokTokenRequest(env,{grant_type:"refresh_token",refresh_token:stored.refreshToken});
    if(refreshed.ok && refreshed.data?.access_token){
      await saveTikTokToken(env,refreshed.data,stored);
      const fresh=await tiktokState(env);
      return {token:fresh.accessToken,source:"oauth",refreshed:true};
    }
  }
  return {token:stored.accessToken,source:"oauth",refreshed:false};
}

async function tiktokApiUserInfo(token, grantedScope=""){
  const scopes=new Set(String(grantedScope||"").split(/[\s,]+/).filter(Boolean));
  // Richiesta minima sempre compatibile con user.info.basic.
  // I campi profile/stats vengono aggiunti solo se lo scope è realmente presente.
  const fields=["open_id","display_name","avatar_url"];
  if(scopes.has("user.info.profile")){
    fields.push("username","profile_deep_link","is_verified");
  }
  if(scopes.has("user.info.stats")){
    fields.push("follower_count","following_count","likes_count","video_count");
  }
  const u=new URL("https://open.tiktokapis.com/v2/user/info/");
  u.searchParams.set("fields",fields.join(","));
  const resp=await fetch(u.toString(),{headers:{"Accept":"application/json","Authorization":`Bearer ${token}`}});
  const data=await resp.json().catch(()=>({}));
  const apiError=data?.error?.code && data.error.code!=="ok";
  return {ok:resp.ok && !apiError,status:resp.status,data,fields,scopes:[...scopes]};
}

async function finishTikTokConnection(request,env,url){
  if(!env.SOCIALHUB_DATA) return new Response("KV SOCIALHUB_DATA non collegato",{status:503});
  if(!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) return Response.redirect(`${url.origin}/backend?tiktok=error&message=${encodeURIComponent("TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET non configurati nel Worker.")}`,303);
  const state=url.searchParams.get("state")||"";
  const code=url.searchParams.get("code")||"";
  const error=url.searchParams.get("error")||"";
  const errorDescription=url.searchParams.get("error_description")||"";
  const storedRaw=await env.SOCIALHUB_DATA.get("oauth:tiktok:state");
  let stored=null; try{stored=storedRaw?JSON.parse(storedRaw):null}catch{}
  await env.SOCIALHUB_DATA.delete("oauth:tiktok:state");
  if(!state || !stored || stored.state!==state){
    return Response.redirect(`${url.origin}/backend?tiktok=error&message=${encodeURIComponent("Stato OAuth TikTok non valido o scaduto.")}`,303);
  }
  if(error || !code){
    const msg=errorDescription || error || "Autorizzazione TikTok annullata.";
    return Response.redirect(`${url.origin}/backend?tiktok=error&message=${encodeURIComponent(msg)}`,303);
  }
  const redirectUri=`${url.origin}/api/accounts/callback/tiktok`;
  const tokenResp=await tiktokTokenRequest(env,{grant_type:"authorization_code",code,redirect_uri:redirectUri});
  if(!tokenResp.ok || !tokenResp.data?.access_token){
    return Response.redirect(`${url.origin}/backend?tiktok=error&message=${encodeURIComponent(`Token TikTok non ottenuto: ${tiktokError(tokenResp.data,tokenResp.status)}`)}`,303);
  }
  await saveTikTokToken(env,tokenResp.data);
  const synced=await syncTikTokAccount(env);
  if(!synced.ok){
    const body=await synced.text().catch(()=>"");
    let msg="TikTok autorizzato, ma sincronizzazione non riuscita.";
    try{msg=JSON.parse(body)?.error||msg}catch{}
    return Response.redirect(`${url.origin}/backend?tiktok=error&message=${encodeURIComponent(msg)}`,303);
  }
  return Response.redirect(`${url.origin}/backend?tiktok=connected`,303);
}

async function syncTikTokAccount(env){
  if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
  const auth=await getTikTokAccessToken(env);
  if(!auth.token){
    const reason=auth.source==="expired" ? "Token TikTok scaduto. Premi Collega per autorizzare di nuovo l'account." : (auth.error ? `Token TikTok non aggiornato: ${auth.error}` : "TikTok: account non autorizzato. Premi Collega e completa TikTok Login.");
    return json({ok:false,error:reason},503);
  }
  const tokenState=await tiktokState(env);
  const grantedScope=tokenState?.scope || "user.info.basic";
  const profile=await tiktokApiUserInfo(auth.token, grantedScope);
  // Se TikTok concede il token ma User Info non restituisce tutti i campi richiesti,
  // non blocchiamo il collegamento: l'account viene comunque salvato come collegato
  // e i dati disponibili possono essere sincronizzati in seguito.
  const user=profile.data?.data?.user || {};
  if(!profile.ok && !user.open_id){
    return json({ok:false,error:`TikTok: ${tiktokError(profile.data,profile.status)}`},502);
  }
  const previous=(await env.SOCIALHUB_DATA.get(CONFIG_KEY).then(raw=>raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG))).accounts?.tiktok || {};
  const username=String(user.username || previous.username || "");
  const displayName=String(user.display_name || username || previous.displayName || "TikTok");
  const followerValue=(user.follower_count!==undefined && user.follower_count!==null) ? String(user.follower_count) : (previous.followerValue || "—");
  const followingValue=(user.following_count!==undefined && user.following_count!==null) ? String(user.following_count) : (previous.followingValue || "—");
  const configRaw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  const config=configRaw?JSON.parse(configRaw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};
  config.accounts.tiktok={
    ...previous,
    connected:true,
    username,
    handle:username ? `@${username}` : (previous.handle || ""),
    displayName,
    profileUrl:user.profile_deep_link || (username ? `https://www.tiktok.com/@${encodeURIComponent(username)}` : (previous.profileUrl || "")),
    tiktokOpenId:user.open_id || previous.tiktokOpenId || "",
    profileImage:user.avatar_url || previous.profileImage || "",
    followerLabel:"Follower",
    followerValue,
    followingValue,
    likesValue:(user.likes_count!==undefined && user.likes_count!==null) ? String(user.likes_count) : (previous.likesValue || "—"),
    videoCount:(user.video_count!==undefined && user.video_count!==null) ? String(user.video_count) : (previous.videoCount || "—"),
    followerSource:"TikTok API v2 user.info.stats",
    lastSync:Date.now(),
    note:"Account TikTok collegato tramite TikTok Login Kit."
  };
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return json({ok:true,account:config.accounts.tiktok,config,message:`TikTok collegato${followerValue!=="—"?` · ${followerValue} follower`:" · follower non disponibili"}.`});
}

async function disconnectTikTokAccount(env){
  if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
  await env.SOCIALHUB_DATA.delete("oauth:tiktok:token");
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};
  const previous=config.accounts.tiktok||{};
  config.accounts.tiktok={...previous,connected:false,followerLabel:"Follower",followerValue:"—",lastSync:0};
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return json({ok:true,config,message:"TikTok scollegato dal pannello."});
}

async function startAccountConnection(id, env, url){
  const allowed = ["instagram","youtube1","youtube2","twitch","kick","tiktok","x"];
  if(!allowed.includes(id)) return json({ok:false,error:"Account non riconosciuto"},400);
  if(id === "x") return json({ok:false,error:PLATFORM_SETUP.x},402);
  if(id === "instagram") {
    const {appId,appSecret}=instagramAppCredentials(env);
    if(!appId || !appSecret) return json({ok:false,error:"Instagram: configura META_APP_ID e META_APP_SECRET nel Worker."},503);
    if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
    const state=crypto.randomUUID();
    await env.SOCIALHUB_DATA.put("oauth:instagram:state",JSON.stringify({state,createdAt:Date.now()}),{expirationTtl:600});
    const redirect=`${url.origin}/api/accounts/callback/instagram`;
    const oauth=new URL("https://www.instagram.com/oauth/authorize");
    oauth.searchParams.set("client_id",appId);
    oauth.searchParams.set("redirect_uri",redirect);
    oauth.searchParams.set("response_type","code");
    oauth.searchParams.set("scope",INSTAGRAM_BASIC_SCOPE);
    oauth.searchParams.set("state",state);
    oauth.searchParams.set("enable_fb_login","0");
    oauth.searchParams.set("force_authentication","1");
    return json({ok:true,ready:true,url:oauth.toString(),message:"Apro Instagram per autorizzare l'account Business."});
  }
  if(id === "tiktok"){
    if(!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) return json({ok:false,error:"TikTok: configura TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET nel Worker."},503);
    if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
    const state=crypto.randomUUID();
    await env.SOCIALHUB_DATA.put("oauth:tiktok:state",JSON.stringify({state,createdAt:Date.now()}),{expirationTtl:600});
    const redirect=`${url.origin}/api/accounts/callback/tiktok`;
    const oauth=new URL("https://www.tiktok.com/v2/auth/authorize/");
    oauth.searchParams.set("client_key",String(env.TIKTOK_CLIENT_KEY).trim());
    oauth.searchParams.set("scope",tikTokScopes(env).join(","));
    oauth.searchParams.set("response_type","code");
    oauth.searchParams.set("redirect_uri",redirect);
    oauth.searchParams.set("state",state);
    return json({ok:true,ready:true,url:oauth.toString(),message:"Apro TikTok per autorizzare l'account."});
  }
  if(id === "youtube1" || id === "youtube2"){
    if(!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ok:false,error:PLATFORM_SETUP[id]},503);
    if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
    const state = await makeYouTubeState(env,id);
    const redirect = `${url.origin}/api/accounts/callback/youtube`;
    const oauth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    oauth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    oauth.searchParams.set("redirect_uri", redirect);
    oauth.searchParams.set("response_type", "code");
    oauth.searchParams.set("access_type", "offline");
    oauth.searchParams.set("prompt", "consent");
    oauth.searchParams.set("include_granted_scopes", "true");
    oauth.searchParams.set("scope", ["https://www.googleapis.com/auth/youtube.readonly","https://www.googleapis.com/auth/youtube.upload","https://www.googleapis.com/auth/youtube.channel-memberships.creator"].join(" "));
    oauth.searchParams.set("state", state);
    const response=json({ok:true,ready:true,url:oauth.toString(),message:`Apro Google per autorizzare ${id === "youtube1" ? "YouTube 1" : "YouTube 2"}.`});
    response.headers.set("Set-Cookie",`socialhub_yt_state=${encodeURIComponent(state)}; Path=/api/accounts/callback/youtube; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
    return response;
  }
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
  if(id === "kick"){
    if(!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) return json({ok:false,error:PLATFORM_SETUP.kick},503);
    if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV SOCIALHUB_DATA non collegato al Worker."},503);
    const state = crypto.randomUUID();
    const codeVerifier = randomKickCodeVerifier();
    const codeChallenge = await kickCodeChallenge(codeVerifier);
    await env.SOCIALHUB_DATA.put("oauth:kick:state", JSON.stringify({state,codeVerifier,createdAt:Date.now()}), {expirationTtl:600});
    const redirect = `${url.origin}/api/accounts/callback/kick`;
    const oauth = new URL("https://id.kick.com/oauth/authorize");
    oauth.searchParams.set("response_type","code");
    oauth.searchParams.set("client_id",env.KICK_CLIENT_ID);
    oauth.searchParams.set("redirect_uri",redirect);
    oauth.searchParams.set("scope","user:read channel:read");
    oauth.searchParams.set("code_challenge",codeChallenge);
    oauth.searchParams.set("code_challenge_method","S256");
    oauth.searchParams.set("state",state);
    return json({ok:true,ready:true,url:oauth.toString(),message:"Apro Kick per autorizzare il tuo canale."});
  }
  return json({ok:false,error:PLATFORM_SETUP[id]},503);
}


async function finishTwitchConnection(request, env, url){
  if(!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return new Response("Credenziali Twitch non configurate",{status:503});
  if(!env.SOCIALHUB_DATA) return new Response("KV SOCIALHUB_DATA non collegato",{status:503});
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const storedRaw = await env.SOCIALHUB_DATA.get("oauth:twitch:state");
  const stored = storedRaw ? JSON.parse(storedRaw) : null;
  if(!state || !code || !stored || stored.state !== state) return new Response("Stato OAuth non valido",{status:400});
  await env.SOCIALHUB_DATA.delete("oauth:twitch:state");
  const tokenResp = await twitchTokenRequest(env, {code, grant_type:"authorization_code", redirect_uri:`${url.origin}/api/accounts/callback/twitch`});
  const token = tokenResp.data;
  if(!tokenResp.ok || !token?.access_token) return new Response(`Errore Twitch OAuth: ${token?.message||"token non ottenuto"}`,{status:502});
  const sync = await fetchTwitchAccountData(env, token.access_token);
  if(!sync.ok) return new Response(`Account Twitch autorizzato ma dati non recuperati: ${sync.error}`,{status:502});
  await storeTwitchToken(env, token);
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};
  config.accounts.twitch=sync.account;
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return new Response(`<html><body style="font-family:system-ui;background:#0c0f15;color:#fff;padding:40px"><h2>Twitch collegato ✓</h2><p>Account: ${escapeHtml(sync.account.handle)}</p><p>Follower: ${escapeHtml(sync.account.followerValue)}</p><p>Abbonati: ${escapeHtml(sync.account.subscriberValue)}</p><p>Puoi chiudere questa finestra e tornare al backend.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`,{headers:{"content-type":"text/html; charset=utf-8"}});
}

async function twitchTokenRequest(env, params){
  const body = new URLSearchParams({client_id:env.TWITCH_CLIENT_ID,client_secret:env.TWITCH_CLIENT_SECRET,...params});
  const resp=await fetch("https://id.twitch.tv/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const data=await resp.json().catch(()=>({message:"Risposta non valida"}));
  return {ok:resp.ok,data};
}

async function storeTwitchToken(env, token){
  await env.SOCIALHUB_DATA.put("oauth:twitch:token",JSON.stringify({accessToken:token.access_token,refreshToken:token.refresh_token,expiresIn:token.expires_in,scope:token.scope,tokenType:token.token_type,updatedAt:Date.now()}));
}

async function getTwitchToken(env){
  const raw=await env.SOCIALHUB_DATA.get("oauth:twitch:token");
  if(!raw) return null;
  try{return JSON.parse(raw)}catch{return null}
}

async function fetchTwitchAccountData(env, accessToken){
  const headers={"Authorization":`Bearer ${accessToken}`,"Client-Id":env.TWITCH_CLIENT_ID};
  const uResp=await fetch("https://api.twitch.tv/helix/users",{headers});
  const uData=await uResp.json().catch(()=>({}));
  if(uResp.status===401) return {ok:false,reauth:true,error:"Token Twitch non valido o scaduto."};
  const user=uData.data?.[0];
  if(!uResp.ok || !user) return {ok:false,error:"Profilo Twitch non recuperato."};

  const fResp=await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(user.id)}`,{headers});
  const fData=await fResp.json().catch(()=>({}));
  if(fResp.status===401) return {ok:false,reauth:true,error:"Token Twitch non valido o scaduto."};

  const sResp=await fetch(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${encodeURIComponent(user.id)}`,{headers});
  const sData=await sResp.json().catch(()=>({}));
  if(sResp.status===401) return {ok:false,reauth:true,error:"Token Twitch non valido o scaduto."};
  // Subscriptions may return 401/403 when scope/eligibility is insufficient; preserve follower data.
  const subValue = sResp.ok ? String(sData.total ?? 0) : "—";
  return {ok:true,account:{connected:true,handle:user.login||user.display_name||"",displayName:user.display_name||user.login||"",profileImage:user.profile_image_url||"",broadcasterId:user.id,followerLabel:"Follower",followerValue:String(fData.total??0),subscriberLabel:"Abbonati",subscriberValue:subValue,lastSync:Date.now()}};
}

async function refreshTwitchToken(env, current){
  if(!current?.refreshToken) return null;
  const result=await twitchTokenRequest(env,{grant_type:"refresh_token",refresh_token:current.refreshToken});
  if(!result.ok || !result.data?.access_token) return null;
  await storeTwitchToken(env,result.data);
  return result.data.access_token;
}

async function syncTwitchAccount(env){
  if(!env.SOCIALHUB_DATA || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return json({ok:false,error:"Configurazione Twitch/KV incompleta."},503);
  let token=await getTwitchToken(env);
  if(!token?.accessToken) return json({ok:false,error:"Twitch non è collegato.",reauth:true},409);
  let result=await fetchTwitchAccountData(env,token.accessToken);
  if(!result.ok && result.reauth){
    const refreshed=await refreshTwitchToken(env,token);
    if(!refreshed) return json({ok:false,error:"Sessione Twitch scaduta. Ricollega Twitch.",reauth:true},401);
    result=await fetchTwitchAccountData(env,refreshed);
  }
  if(!result.ok) return json({ok:false,error:result.error||"Impossibile aggiornare Twitch."},502);
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};config.accounts.twitch=result.account;
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return json({ok:true,account:result.account,config});
}

async function disconnectTwitchAccount(env){
  if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV non collegato."},503);
  const token=await getTwitchToken(env);
  if(token?.accessToken && env.TWITCH_CLIENT_ID){
    try{await fetch(`https://id.twitch.tv/oauth2/revoke?client_id=${encodeURIComponent(env.TWITCH_CLIENT_ID)}&token=${encodeURIComponent(token.accessToken)}`,{method:"POST"})}catch{}
  }
  await env.SOCIALHUB_DATA.delete("oauth:twitch:token");
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};config.accounts.twitch={connected:false};
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return json({ok:true,config});
}


function randomKickCodeVerifier(){
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s="";
  for(const b of bytes) s += String.fromCharCode(b);
  return b64url(new TextEncoder().encode(s));
}
async function kickCodeChallenge(verifier){
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(hash));
}
async function kickTokenRequest(env, params){
  const body=new URLSearchParams({client_id:env.KICK_CLIENT_ID,client_secret:env.KICK_CLIENT_SECRET,...params});
  const resp=await fetch("https://id.kick.com/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const data=await resp.json().catch(()=>({message:"Risposta non valida da Kick OAuth"}));
  return {ok:resp.ok,data};
}
async function getKickToken(env){
  const raw=await env.SOCIALHUB_DATA?.get("oauth:kick:token");
  if(!raw) return null;
  try{return JSON.parse(raw)}catch{return null}
}
async function storeKickToken(env,token){
  await env.SOCIALHUB_DATA.put("oauth:kick:token",JSON.stringify({accessToken:token.access_token,refreshToken:token.refresh_token,expiresIn:token.expires_in,scope:token.scope,tokenType:token.token_type,updatedAt:Date.now(),expiresAt:Date.now()+Number(token.expires_in||0)*1000}));
}
async function refreshKickToken(env,current){
  if(!current?.refreshToken) return null;
  const result=await kickTokenRequest(env,{grant_type:"refresh_token",refresh_token:current.refreshToken});
  if(!result.ok || !result.data?.access_token) return null;
  await storeKickToken(env,result.data);
  return result.data.access_token;
}
async function kickApiRequest(accessToken,path){
  const resp=await fetch(`https://api.kick.com${path}`,{headers:{Authorization:`Bearer ${accessToken}`,Accept:"application/json"}});
  const data=await resp.json().catch(()=>({}));
  return {ok:resp.ok,status:resp.status,data};
}
async function kickFollowersCount(broadcasterUserId,channelSlug){
  const id=String(broadcasterUserId||"").trim();
  const slug=String(channelSlug||"").trim();
  if(!id && !slug) return null;
  try{
    const candidates=[];
    if(id) candidates.push(`https://api.kick.com/channels/${encodeURIComponent(id)}/followers-count`);
    if(slug) candidates.push(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`);
    for(const endpoint of candidates){
      const resp=await fetch(endpoint,{headers:{Accept:"application/json"}});
      if(!resp.ok) continue;
      const data=await resp.json().catch(()=>({}));
      const value=data?.followers_count ?? data?.data?.followers_count ?? data?.data?.channel?.followers_count;
      if(value!==undefined && value!==null && value!=="") return Number(value);
    }
  }catch{}
  return null;
}
async function fetchKickAccountData(env,accessToken){
  const userResp=await kickApiRequest(accessToken,"/public/v1/users");
  if(userResp.status===401) return {ok:false,reauth:true,error:"Token Kick non valido o scaduto."};
  const user=userResp.data?.data?.[0] || userResp.data?.data || null;
  if(!userResp.ok || !user?.user_id) return {ok:false,error:"Profilo Kick non recuperato. Verifica che l'account OAuth autorizzato sia il tuo canale."};

  const chResp=await kickApiRequest(accessToken,`/public/v1/channels?broadcaster_user_id=${encodeURIComponent(user.user_id)}`);
  if(chResp.status===401) return {ok:false,reauth:true,error:"Token Kick non valido o scaduto."};
  const channels=Array.isArray(chResp.data?.data)?chResp.data.data:[];
  const ch=channels[0];
  if(!chResp.ok || !ch) return {ok:false,error:"Canale Kick non recuperato dall'API ufficiale."};

  const followers=await kickFollowersCount(ch.broadcaster_user_id||user.user_id,ch.slug||user.username||"");
  const subCount=ch.active_subscribers_count;
  return {ok:true,account:{connected:true,handle:ch.slug||user.username||"",displayName:user.username||ch.slug||"Kick",profileImage:user.profile_picture||user.profilePicture||"",broadcasterUserId:String(ch.broadcaster_user_id||user.user_id),channelSlug:ch.slug||user.username||"",followerLabel:"Follower",followerValue:followers===null?"—":String(followers),subscriberLabel:"Abbonati",subscriberValue:(subCount===undefined||subCount===null)?"—":String(subCount),lastSync:Date.now()}};
}
async function finishKickConnection(request,env,url){
  if(!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) return new Response("Credenziali Kick non configurate",{status:503});
  if(!env.SOCIALHUB_DATA) return new Response("KV SOCIALHUB_DATA non collegato",{status:503});
  const error=url.searchParams.get("error");
  if(error) return new Response(`<html><body style="font-family:system-ui;background:#0c0f15;color:#fff;padding:40px"><h2>Collegamento Kick non completato</h2><p>${escapeHtml(url.searchParams.get("error_description")||error)}</p><script>setTimeout(()=>window.close(),1800)</script></body></html>`,{headers:{"content-type":"text/html; charset=utf-8"}});
  const state=url.searchParams.get("state");
  const code=url.searchParams.get("code");
  const storedRaw=await env.SOCIALHUB_DATA.get("oauth:kick:state");
  const stored=storedRaw?JSON.parse(storedRaw):null;
  if(!state || !code || !stored || stored.state!==state || !stored.codeVerifier) return new Response("Stato OAuth Kick non valido",{status:400});
  await env.SOCIALHUB_DATA.delete("oauth:kick:state");
  const tokenResp=await kickTokenRequest(env,{grant_type:"authorization_code",code,redirect_uri:`${url.origin}/api/accounts/callback/kick`,code_verifier:stored.codeVerifier});
  const token=tokenResp.data;
  if(!tokenResp.ok || !token?.access_token) return new Response(`Errore Kick OAuth: ${escapeHtml(token?.message||token?.error_description||token?.error||"token non ottenuto")}`,{status:502});
  const sync=await fetchKickAccountData(env,token.access_token);
  if(!sync.ok) return new Response(`Kick autorizzato ma dati non recuperati: ${escapeHtml(sync.error||"errore sconosciuto")}`,{status:502});
  await storeKickToken(env,token);
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};config.accounts.kick=sync.account;
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return new Response(`<html><body style="font-family:system-ui;background:#0c0f15;color:#fff;padding:40px"><h2>Kick collegato ✓</h2><p>Canale: ${escapeHtml(sync.account.channelSlug||sync.account.handle)}</p><p>Follower: ${escapeHtml(sync.account.followerValue)}</p><p>Abbonati: ${escapeHtml(sync.account.subscriberValue)}</p><p>Puoi chiudere questa finestra e tornare al backend.</p><script>setTimeout(()=>window.close(),1400)</script></body></html>`,{headers:{"content-type":"text/html; charset=utf-8"}});
}
async function syncKickAccount(env){
  if(!env.SOCIALHUB_DATA || !env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) return json({ok:false,error:"Configurazione Kick/KV incompleta."},503);
  let token=await getKickToken(env);
  if(!token?.accessToken) return json({ok:false,error:"Kick non è collegato. Premi Collega.",reauth:true},409);
  if(token.expiresAt && Date.now()>Number(token.expiresAt)-60000){
    const refreshed=await refreshKickToken(env,token);
    if(!refreshed) return json({ok:false,error:"Sessione Kick scaduta. Ricollega Kick.",reauth:true},401);
    token=await getKickToken(env);
  }
  let result=await fetchKickAccountData(env,token.accessToken);
  if(!result.ok && result.reauth){
    const refreshed=await refreshKickToken(env,token);
    if(!refreshed) return json({ok:false,error:"Sessione Kick scaduta. Ricollega Kick.",reauth:true},401);
    result=await fetchKickAccountData(env,refreshed);
  }
  if(!result.ok) return json({ok:false,error:result.error||"Impossibile aggiornare Kick."},502);
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};config.accounts.kick=result.account;
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return json({ok:true,account:result.account,config});
}
async function disconnectKickAccount(env){
  if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV non collegato."},503);
  const token=await getKickToken(env);
  if(token?.accessToken){
    try{await fetch("https://id.kick.com/oauth/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:token.accessToken,client_id:env.KICK_CLIENT_ID||""})})}catch{}
  }
  await env.SOCIALHUB_DATA.delete("oauth:kick:token");
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};config.accounts.kick={connected:false};
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return json({ok:true,config});
}

async function googleTokenRequest(env, params){
  const body = new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,...params});
  const resp = await fetch("https://oauth2.googleapis.com/token", {method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const data = await resp.json().catch(()=>({error_description:"Risposta non valida"}));
  return {ok:resp.ok,data};
}

async function googleApi(url, accessToken, options={}){
  const headers = new Headers(options.headers||{});
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(url, {...options,headers});
}

async function getYouTubeToken(env, slot){
  const raw=await env.SOCIALHUB_DATA.get(`oauth:youtube:token:${slot}`);
  if(!raw) return null;
  try{return JSON.parse(raw)}catch{return null}
}

async function storeYouTubeToken(env, slot, token){
  await env.SOCIALHUB_DATA.put(`oauth:youtube:token:${slot}`, JSON.stringify({
    accessToken:token.access_token,
    refreshToken:token.refresh_token || "",
    expiresIn:token.expires_in || 0,
    scope:token.scope || "",
    tokenType:token.token_type || "Bearer",
    updatedAt:Date.now()
  }));
}

async function refreshYouTubeToken(env, slot, current){
  if(!current?.refreshToken) return null;
  const result=await googleTokenRequest(env,{grant_type:"refresh_token",refresh_token:current.refreshToken});
  if(!result.ok || !result.data?.access_token) return null;
  await storeYouTubeToken(env,slot,{...result.data,refresh_token:current.refreshToken});
  return result.data.access_token;
}

async function finishYouTubeConnection(request, env, url){
  if(!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return new Response("Credenziali Google non configurate",{status:503});
  if(!env.SOCIALHUB_DATA) return new Response("KV SOCIALHUB_DATA non collegato",{status:503});
  const state=url.searchParams.get("state");
  const code=url.searchParams.get("code");
  const cookieState=getCookie(request,"socialhub_yt_state");
  if(!state || !code) return new Response("Autorizzazione Google incompleta",{status:400});
  if(!cookieState || cookieState!==state) return new Response("Stato OAuth Google non valido: cookie mancante o non corrispondente",{status:400});
  const stored=await verifyYouTubeState(env,state);
  if(!stored) return new Response("Stato OAuth Google scaduto o non valido",{status:400});
  const tokenResp=await googleTokenRequest(env,{code,grant_type:"authorization_code",redirect_uri:`${url.origin}/api/accounts/callback/youtube`});
  const token=tokenResp.data;
  if(!tokenResp.ok || !token?.access_token) return new Response(`Errore Google OAuth: ${escapeHtml(token?.error_description||token?.error||"token non ottenuto")}`,{status:502});
  await storeYouTubeToken(env,stored.slot,token);
  const channels=await fetchYouTubeChannels(env,token.access_token);
  if(!channels.ok) return new Response(`Autorizzazione riuscita, ma i canali YouTube non sono stati recuperati: ${escapeHtml(channels.error)}`,{status:502});
  if(channels.items.length===0) return new Response("Nessun canale YouTube disponibile per questo account Google.",{status:404});
  const configRaw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);
  const config=configRaw?JSON.parse(configRaw):structuredClone(DEFAULT_CONFIG);
  const otherSlot=stored.slot==='youtube1'?'youtube2':'youtube1';
  const usedChannelId=config.accounts?.[otherSlot]?.channelId || "";
  const available=channels.items.filter(ch=>ch.id!==usedChannelId);
  if(channels.items.length===1){
    if(channels.items[0].id===usedChannelId){
      return withClearedYouTubeCookie(new Response(`Il canale YouTube disponibile è già associato a ${escapeHtml(otherSlot==='youtube1'?'YouTube 1':'YouTube 2')}. Questo account Google non presenta un secondo canale utilizzabile.`,{status:409}));
    }
    await saveSelectedYouTubeChannel(env,stored.slot,channels.items[0]);
    return withClearedYouTubeCookie(youtubeDonePage(stored.slot,channels.items[0]));
  }
  if(available.length===0){
    return withClearedYouTubeCookie(new Response(`Tutti i canali YouTube restituiti da Google sono già associati agli slot YouTube 1/YouTube 2.`,{status:409}));
  }
  const options=channels.items.map(ch=>{
    const used=ch.id===usedChannelId;
    if(used){
      return `<div style="display:block;padding:14px 16px;margin:8px 0;background:#121722;border:1px solid #333b4c;border-radius:12px;color:#7f8999;opacity:.72"><strong>${escapeHtml(ch.title)}</strong><div style="font-size:12px;margin-top:4px">${escapeHtml(ch.subscriberValue)} iscritti · già associato a ${escapeHtml(otherSlot==='youtube1'?'YouTube 1':'YouTube 2')}</div></div>`;
    }
    return `<a href="${escapeAttr(`${url.origin}/api/accounts/youtube/select?slot=${encodeURIComponent(stored.slot)}&channelId=${encodeURIComponent(ch.id)}`)}" style="display:block;padding:14px 16px;margin:8px 0;background:#151a24;border:1px solid #30384a;border-radius:12px;color:#fff;text-decoration:none"><strong>${escapeHtml(ch.title)}</strong><div style="color:#8e98a8;font-size:12px;margin-top:4px">${escapeHtml(ch.subscriberValue)} iscritti · associa a ${escapeHtml(stored.slot==='youtube1'?'YouTube 1':'YouTube 2')}</div></a>`;
  }).join('');
  return withClearedYouTubeCookie(new Response(`<html><body style="font-family:system-ui;background:#0b0e14;color:#fff;padding:40px;max-width:720px;margin:auto"><h2>Seleziona il canale per ${escapeHtml(stored.slot==='youtube1'?'YouTube 1':'YouTube 2')}</h2><p style="color:#9aa4b2">Google ha restituito più canali. Scegli il canale da associare a questa scheda. Quello già utilizzato nell'altro slot viene mostrato come occupato.</p>${options}</body></html>`,{headers:{"content-type":"text/html; charset=utf-8"}}));
}

async function fetchYouTubeChannels(env, accessToken){
  const resp=await googleApi("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",accessToken);
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok) return {ok:false,error:data?.error?.message||"Errore YouTube channels.list"};
  const items=(data.items||[]).map(ch=>({id:ch.id,title:ch.snippet?.title||"Canale YouTube",handle:ch.snippet?.customUrl||"",profileImage:ch.snippet?.thumbnails?.default?.url||ch.snippet?.thumbnails?.medium?.url||"",subscriberValue:String(ch.statistics?.subscriberCount??"—") ,viewCount:String(ch.statistics?.viewCount??"—")}));
  return {ok:true,items};
}

async function selectYouTubeChannel(request, env, url){
  const slot=url.searchParams.get("slot");
  const channelId=url.searchParams.get("channelId");
  if(!["youtube1","youtube2"].includes(slot) || !channelId) return new Response("Parametri non validi",{status:400});
  const token=await getYouTubeToken(env,slot);
  if(!token?.accessToken) return new Response("Autorizzazione YouTube non trovata",{status:409});
  const channel=await fetchYouTubeChannelById(env,token.accessToken,channelId);
  if(!channel.ok) return new Response(`Canale non recuperato: ${escapeHtml(channel.error)}`,{status:502});
  await saveSelectedYouTubeChannel(env,slot,channel.account);
  return youtubeDonePage(slot,channel.account);
}

async function fetchYouTubeChannelById(env,accessToken,channelId){
  const resp=await googleApi(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(channelId)}`,accessToken);
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok || !data.items?.[0]) return {ok:false,error:data?.error?.message||"Canale YouTube non trovato"};
  const ch=data.items[0];
  return {ok:true,account:{id:ch.id,title:ch.snippet?.title||"Canale YouTube",handle:ch.snippet?.customUrl||"",profileImage:ch.snippet?.thumbnails?.medium?.url||ch.snippet?.thumbnails?.default?.url||"",followerLabel:"Iscritti",followerValue:String(ch.statistics?.subscriberCount??"—"),viewCount:String(ch.statistics?.viewCount??"—")}};
}

async function saveSelectedYouTubeChannel(env,slot,account){
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);
  config.accounts=config.accounts||{};
  config.accounts[slot]={connected:true,handle:account.handle||account.title,displayName:account.title,channelId:account.id,profileImage:account.profileImage||"",followerLabel:"Iscritti",followerValue:String(account.followerValue??"—"),subscriberLabel:"Membri",subscriberValue:"—",lastSync:Date.now(),viewCount:String(account.viewCount??"")};
  await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return config;
}

function withClearedYouTubeCookie(response){response.headers.set("Set-Cookie",clearCookieHeader());return response;}

function youtubeDonePage(slot,account){
  return new Response(`<html><body style="font-family:system-ui;background:#0b0e14;color:#fff;padding:40px"><h2>${escapeHtml(slot==='youtube1'?'YouTube 1':'YouTube 2')} collegato ✓</h2><p>Canale: ${escapeHtml(account.title||account.handle||"")}</p><p>Iscritti: ${escapeHtml(account.followerValue||"—")}</p><p>Puoi chiudere questa finestra e tornare al backend.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`,{headers:{"content-type":"text/html; charset=utf-8"}});
}

async function syncYouTubeAccount(env,slot){
  if(!env.SOCIALHUB_DATA || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ok:false,error:"Configurazione Google/KV incompleta."},503);
  if(!["youtube1","youtube2"].includes(slot)) return json({ok:false,error:"Slot YouTube non valido."},400);
  let token=await getYouTubeToken(env,slot);
  if(!token?.accessToken) return json({ok:false,error:"YouTube non è collegato.",reauth:true},409);
  const current=await env.SOCIALHUB_DATA.get(CONFIG_KEY);let config=current?JSON.parse(current):structuredClone(DEFAULT_CONFIG);const channelId=config.accounts?.[slot]?.channelId;
  if(!channelId) return json({ok:false,error:"Canale YouTube non associato.",reauth:true},409);
  let result=await fetchYouTubeChannelById(env,token.accessToken,channelId);
  if(!result.ok){
    const refreshed=await refreshYouTubeToken(env,slot,token);
    if(!refreshed) return json({ok:false,error:"Sessione Google scaduta. Ricollega YouTube.",reauth:true},401);
    result=await fetchYouTubeChannelById(env,refreshed,channelId);
  }
  if(!result.ok) return json({ok:false,error:result.error||"Impossibile aggiornare YouTube."},502);
  const account={...config.accounts[slot],...result.account,lastSync:Date.now()};
  // Try current paid channel members count when the API is enabled for the creator; otherwise retain an honest unavailable state.
  let memberValue="—";
  const tokenNow=await getYouTubeToken(env,slot);
  if(tokenNow?.accessToken){
    try{
      const m=await googleApi("https://www.googleapis.com/youtube/v3/members?part=snippet&maxResults=1",tokenNow.accessToken);
      if(m.ok){const md=await m.json().catch(()=>({}));memberValue=String(md.pageInfo?.totalResults??"—");}
    }catch{}
  }
  account.subscriberLabel="Membri";account.subscriberValue=memberValue;
  config.accounts[slot]=account;await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return json({ok:true,account,config});
}

async function disconnectYouTubeAccount(env,slot){
  if(!env.SOCIALHUB_DATA) return json({ok:false,error:"KV non collegato."},503);
  const token=await getYouTubeToken(env,slot);
  if(token?.accessToken){try{await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token.accessToken)}`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"}})}catch{}}
  await env.SOCIALHUB_DATA.delete(`oauth:youtube:token:${slot}`);
  const raw=await env.SOCIALHUB_DATA.get(CONFIG_KEY);const config=raw?JSON.parse(raw):structuredClone(DEFAULT_CONFIG);config.accounts=config.accounts||{};config.accounts[slot]={connected:false};await env.SOCIALHUB_DATA.put(CONFIG_KEY,JSON.stringify(config));
  return json({ok:true,config});
}

function escapeAttr(v){return String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')}

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
  return json({ok:true,sent:false,status:'prepared',message:"Selezione validata e bozza salvata. NESSUN SOCIAL HA RICEVUTO IL POST: l'invio reale non è ancora attivo.",config});
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
  const allowed=["instagram","youtube1","youtube2","twitch","kick","tiktok","x","discord"];
  const out={};
  for (const id of allowed) {
    const row=input?.[id] || {};
    out[id]={href:String(row.href || "").slice(0,1000),description:String(row.description || "").slice(0,180)};
  }
  return out;
}
function sanitizeAccounts(input) {
  const allowed=["instagram","youtube1","youtube2","twitch","kick","tiktok","x","discord"];
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
