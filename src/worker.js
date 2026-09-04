
const FRONTEND_URL = "https://socialhub-web.the-sync-fm.workers.dev/";
const TWITCH_REDIRECT_URI = "https://socialhub-web.the-sync-fm.workers.dev/auth/twitch/callback";
const COOKIE_NAME = "socialhub_session";
const OAUTH_SCOPE = "moderator:read:followers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, service: "SocialHub", status: "online" });
      }

      if (url.pathname === "/auth/twitch/start") {
        const state = randomToken();
        await env.SOCIALHUB_KV.put(`oauth_state:${state}`, JSON.stringify({ created_at: Date.now() }), { expirationTtl: 600 });
        const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
        authUrl.searchParams.set("client_id", env.TWITCH_CLIENT_ID);
        authUrl.searchParams.set("redirect_uri", TWITCH_REDIRECT_URI);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", OAUTH_SCOPE);
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("force_verify", "true");
        return Response.redirect(authUrl.toString(), 302);
      }

      if (url.pathname === "/auth/twitch/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const oauthError = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (oauthError) return redirectWithError(`${oauthError}${errorDescription ? `: ${errorDescription}` : ""}`);
        if (!code || !state) return redirectWithError("Parametri OAuth mancanti");

        const stateKey = `oauth_state:${state}`;
        const stateData = await env.SOCIALHUB_KV.get(stateKey);
        if (!stateData) return redirectWithError("Stato OAuth non valido o scaduto");
        await env.SOCIALHUB_KV.delete(stateKey);

        const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.TWITCH_CLIENT_ID,
            client_secret: env.TWITCH_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
            redirect_uri: TWITCH_REDIRECT_URI,
          }),
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) return redirectWithError("Impossibile ottenere il token Twitch");

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const expiresIn = Number(tokenData.expires_in || 0);

        const userResponse = await twitchFetch("https://api.twitch.tv/helix/users", env.TWITCH_CLIENT_ID, accessToken);
        const userData = await userResponse.json();
        const user = userData.data?.[0];
        if (!userResponse.ok || !user) return redirectWithError("Impossibile leggere il profilo Twitch");

        const sessionId = randomToken();
        await env.SOCIALHUB_KV.put(`session:${sessionId}`, JSON.stringify({
          twitch_user_id: user.id,
          login: user.login,
          display_name: user.display_name,
          profile_image_url: user.profile_image_url,
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: Date.now() + Math.max(0, expiresIn - 60) * 1000,
          created_at: Date.now(),
        }), { expirationTtl: 60 * 60 * 24 * 7 });

        const headers = new Headers({ Location: FRONTEND_URL + "?twitch=connected" });
        headers.append("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === "/auth/twitch/logout") {
        const sessionId = getCookie(request, COOKIE_NAME);
        if (sessionId) await env.SOCIALHUB_KV.delete(`session:${sessionId}`);
        const headers = new Headers({ "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" });
        headers.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
        return new Response(JSON.stringify({ ok: true, logged_out: true }), { headers });
      }

      if (url.pathname === "/twitch/me") {
        const sessionId = getCookie(request, COOKIE_NAME);
        if (!sessionId) return json({ ok:false, error:"Non autenticato" }, 401);

        const result = await loadSession(env, sessionId);
        if (!result) return json({ ok:false, error:"Sessione non valida o scaduta" }, 401);
        if (result.changed) {
          await env.SOCIALHUB_KV.put(`session:${sessionId}`, JSON.stringify(result.session), { expirationTtl: 60 * 60 * 24 * 7 });
        }

        const session = result.session;
        const userResponse = await twitchFetch("https://api.twitch.tv/helix/users", env.TWITCH_CLIENT_ID, session.access_token);
        const userData = await userResponse.json();
        const user = userData.data?.[0];
        if (!userResponse.ok || !user) return json({ ok:false, error:"Token Twitch non valido" }, 401);

        const followerResponse = await twitchFetch(
          `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(user.id)}`,
          env.TWITCH_CLIENT_ID,
          session.access_token
        );
        const followerData = await followerResponse.json();
        const followerCount = followerResponse.ok && typeof followerData.total === "number" ? followerData.total : null;

        const appToken = await getAppToken(env);
        const streamResponse = await fetch(
          `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(user.id)}`,
          { headers: { Authorization:`Bearer ${appToken}`, "Client-Id":env.TWITCH_CLIENT_ID } }
        );
        const streamData = await streamResponse.json();
        const stream = streamData.data?.[0] ?? null;

        return json({
          ok:true,
          account:{
            id:user.id, login:user.login, display_name:user.display_name,
            description:user.description, profile_image_url:user.profile_image_url,
            created_at:user.created_at
          },
          followers:followerCount,
          live: stream ? {
            is_live:true, title:stream.title, game_name:stream.game_name,
            viewer_count:stream.viewer_count, started_at:stream.started_at,
            language:stream.language, thumbnail_url:stream.thumbnail_url
          } : { is_live:false }
        });
      }

      if (url.pathname === "/twitch/status") {
        const login = url.searchParams.get("login");
        if (!login) return json({ ok:false, error:"Parametro login mancante" },400);
        const token = await getAppToken(env);
        const userResponse = await twitchFetch(
          `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
          env.TWITCH_CLIENT_ID, token
        );
        const userData = await userResponse.json();
        const user = userData.data?.[0];
        if (!userResponse.ok || !user) return json({ ok:false, error:"Canale Twitch non trovato" },404);

        const streamResponse = await twitchFetch(
          `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(user.id)}`,
          env.TWITCH_CLIENT_ID, token
        );
        const streamData = await streamResponse.json();
        const stream = streamData.data?.[0] ?? null;

        return json({
          ok:true,
          channel:{
            id:user.id, login:user.login, display_name:user.display_name,
            description:user.description, profile_image_url:user.profile_image_url,
            offline_image_url:user.offline_image_url, created_at:user.created_at
          },
          live:stream ? {
            is_live:true, title:stream.title, game_name:stream.game_name,
            viewer_count:stream.viewer_count, started_at:stream.started_at,
            language:stream.language, thumbnail_url:stream.thumbnail_url
          } : { is_live:false }
        });
      }

      // Same Worker, same origin: serve the site files.
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ ok:false, error:"Errore interno" },500);
    }
  }
};

async function loadSession(env, sessionId) {
  const raw = await env.SOCIALHUB_KV.get(`session:${sessionId}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (session.expires_at && Date.now() < session.expires_at) return { session, changed:false };
  if (!session.refresh_token) return null;

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:env.TWITCH_CLIENT_ID,
      client_secret:env.TWITCH_CLIENT_SECRET,
      grant_type:"refresh_token",
      refresh_token:session.refresh_token
    })
  });
  const data = await response.json();
  if (!response.ok) return null;

  session.access_token = data.access_token;
  if (data.refresh_token) session.refresh_token = data.refresh_token;
  session.expires_at = Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000;
  return { session, changed:true };
}

async function getAppToken(env) {
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:env.TWITCH_CLIENT_ID,
      client_secret:env.TWITCH_CLIENT_SECRET,
      grant_type:"client_credentials"
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Twitch App Token error");
  return data.access_token;
}

async function twitchFetch(endpoint, clientId, accessToken) {
  return fetch(endpoint, { headers:{ Authorization:`Bearer ${accessToken}`, "Client-Id":clientId } });
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";").map(v => v.trim())) {
    const idx = part.indexOf("=");
    if (idx !== -1 && part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2,"0")).join("");
}

function redirectWithError(message) {
  const target = new URL(FRONTEND_URL);
  target.searchParams.set("twitch","error");
  target.searchParams.set("message",message);
  return Response.redirect(target.toString(),302);
}

function json(data, status=200) {
  return new Response(JSON.stringify(data,null,2), {
    status,
    headers:{
      "Content-Type":"application/json; charset=UTF-8",
      "Cache-Control":"no-store"
    }
  });
}
