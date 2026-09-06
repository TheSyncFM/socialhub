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
      if (url.pathname === "/api/diagnostic/config" && request.method === "GET") return diagnosticConfig(env);

      if (url.pathname.startsWith("/api/accounts/connect/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/accounts/connect/".length));
        if (request.method !== "GET") return json({ ok:false, error:"Metodo non supportato" },405);
        return startAccountConnection(id, env, url);
      }
      if (url.pathname === "/api/accounts/callback/twitch" && request.method === "GET") return finishTwitchConnection(request, env, url);
      if (url.pathname === "/api/accounts/sync/twitch" && request.method === "POST") return syncTwitchAccount(env);
      if (url.pathname === "/api/accounts/disconnect/twitch" && request.method === "POST") return disconnectTwitchAccount(env);
      if (url.pathname === "/api/accounts/callback/youtube" && request.method === "GET") return finishYouTubeConnection(request, env, url);
      if (url.pathname === "/api/accounts/youtube/select" && request.method === "GET") return selectYouTubeChannel(request, env, url);
      if (url.pathname.startsWith("/api/accounts/sync/youtube") && request.method === "POST") {
        const slot = decodeURIComponent(url.pathname.slice("/api/accounts/sync/youtube/".length));
        return syncYouTubeAccount(env, slot);
      }
      if (url.pathname.startsWith("/api/accounts/disconnect/youtube") && request.method === "POST") {
        const slot = decodeURIComponent(url.pathname.slice("/api/accounts/disconnect/youtube/".length));
        return disconnectYouTubeAccount(env, slot);
      }
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
