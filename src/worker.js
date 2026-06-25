/**
 * 名古屋市障がい福祉マップ — Worker エントリ。
 *
 * 役割:
 *  - /api/config        … クライアントへ GoogleクライアントID と「ログイン中か」を返す。
 *  - /api/login (POST)  … GoogleのIDトークンを検証→許可メールなら通行証Cookieを発行。
 *  - /api/logout (POST) … 通行証Cookieを破棄。
 *  - /api/memo/<事業所ID>… 事業所メモの読み書き（KV保存）。ログイン必須＝本人だけ。
 *  - それ以外           … 静的アセット（index.html / css / js / data）をそのまま配信。
 *
 * 認証方式: ブラウザは「Sign in with Google」でGoogleのIDトークン(JWT)を取得し /api/login へ送る。
 * Worker は Google の公開鍵(JWKS)で署名検証し、aud=自分のクライアントID・発行者・有効期限・
 * email_verified を確認。許可メール(ALLOWED_EMAILS)に含まれていれば、自前の署名付きCookie
 * (HMAC-SHA256 / SESSION_SECRET)を発行する。以降はそのCookieで本人確認する（Googleトークンは
 * 短命なので毎回は使わない）。
 *
 * 必要な環境変数:
 *  - GOOGLE_CLIENT_ID … OAuthクライアントID（公開情報。wrangler.jsonc の vars でよい）
 *  - SESSION_SECRET   … 通行証Cookie署名用のランダム秘密（wrangler secret）
 *  - ALLOWED_EMAILS   … 許可メール（カンマ区切り。wrangler secret）
 */

const SESSION_COOKIE = "session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 通行証の有効期間: 30日

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/config") return handleConfig(request, env);
    if (p === "/api/login") return handleLogin(request, env);
    if (p === "/api/logout") return handleLogout();
    if (p.startsWith("/api/memo")) return handleMemoApi(request, env, url);

    // それ以外は静的アセットへ委譲（従来どおり）。
    return env.ASSETS.fetch(request);
  },
};

// ── 設定・認証エンドポイント ──────────────────────────────

// クライアント初期化用。クライアントIDと現在のログイン状態を返す。
async function handleConfig(request, env) {
  const user = await authenticate(request, env);
  return json({ clientId: env.GOOGLE_CLIENT_ID || null, user });
}

// GoogleのIDトークンを受け取り、検証＋許可判定して通行証Cookieを発行。
async function handleLogin(request, env) {
  if (request.method !== "POST") return json({ error: "POSTのみ" }, 405);
  if (!env.SESSION_SECRET || !env.ALLOWED_EMAILS) {
    return json({ error: "サーバー側の認証設定が未完了です" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "リクエストが不正です" }, 400);
  }
  const credential = body && body.credential;
  if (!credential) return json({ error: "認証情報がありません" }, 400);

  const guser = await verifyGoogleIdToken(credential, env);
  if (!guser) return json({ error: "Googleの認証に失敗しました" }, 401);
  if (!isAllowed(guser.email, env)) {
    return json({ error: "このアカウントには許可がありません" }, 403);
  }

  const token = await createSession(guser, env);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS));
  return new Response(
    JSON.stringify({ user: { email: guser.email, name: guser.name } }),
    { status: 200, headers }
  );
}

async function handleLogout() {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// ── メモAPI ────────────────────────────────────────────

// /api/memo/<事業所ID> : GET=取得 / PUT=保存（空文字で削除）
async function handleMemoApi(request, env, url) {
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/memo\/?/, "")).trim();

  // ログイン確認。未ログインは弾く（閲覧も本人だけ）。
  const user = await authenticate(request, env);
  if (!user) return json({ error: "ログインが必要です" }, 401);

  if (!env.MEMOS) return json({ error: "メモ保存先(KV)が未設定です" }, 500);
  if (!id) return json({ error: "事業所IDがありません" }, 400);

  const key = `memo:${id}`;

  if (request.method === "GET") {
    const raw = await env.MEMOS.get(key);
    return json(raw ? JSON.parse(raw) : null);
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "リクエストが不正です" }, 400);
    }
    const text = (body && typeof body.text === "string" ? body.text : "").trim();

    // 空文字なら削除扱い。
    if (!text) {
      await env.MEMOS.delete(key);
      return json(null);
    }

    const record = {
      text: text.slice(0, 4000), // 文字数の上限（暴走防止）
      author: user.name || user.email,
      updatedAt: new Date().toISOString(),
    };
    await env.MEMOS.put(key, JSON.stringify(record));
    return json(record);
  }

  return json({ error: "許可されていないメソッドです" }, 405);
}

// ── 認証ロジック ───────────────────────────────────────

// 通行証Cookieからログイン中のユーザーを返す。なければ null。
async function authenticate(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  return verifySession(cookies[SESSION_COOKIE], env);
}

// 許可メール一覧（カンマ区切り）に含まれるか。
function isAllowed(email, env) {
  const list = (env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes((email || "").toLowerCase());
}

// GoogleのIDトークン(JWT/RS256)を公開鍵で検証し、{email,name} を返す。失敗時 null。
let jwksCache = null;
let jwksFetchedAt = 0;
async function getGoogleKeys() {
  const now = Date.now();
  if (jwksCache && now - jwksFetchedAt < 60 * 60 * 1000) return jwksCache;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  const data = await res.json();
  jwksCache = data.keys;
  jwksFetchedAt = now;
  return jwksCache;
}

async function verifyGoogleIdToken(credential, env) {
  const parts = credential.split(".");
  if (parts.length !== 3) return null;
  const [h, pl, sg] = parts;

  let header;
  try {
    header = JSON.parse(b64urlToString(h));
  } catch {
    return null;
  }

  const keys = await getGoogleKeys();
  const jwk = (keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sg),
    new TextEncoder().encode(h + "." + pl)
  );
  if (!ok) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlToString(pl));
  } catch {
    return null;
  }

  const iss = payload.iss;
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") return null;
  if (env.GOOGLE_CLIENT_ID && payload.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.email_verified !== true && payload.email_verified !== "true") return null;

  return {
    email: (payload.email || "").toLowerCase(),
    name: payload.name || payload.email,
  };
}

// ── 通行証Cookie（HMAC署名）──────────────────────────────

async function createSession(user, env) {
  const payload = b64urlEncode(
    JSON.stringify({
      email: user.email,
      name: user.name,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    })
  );
  const sig = await hmac(payload, env.SESSION_SECRET);
  return payload + "." + sig;
}

async function verifySession(token, env) {
  if (!token || !env.SESSION_SECRET) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await hmac(payload, env.SESSION_SECRET);
  if (!timingSafeEqual(sig, expected)) return null;

  let data;
  try {
    data = JSON.parse(b64urlToString(payload));
  } catch {
    return null;
  }
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return { email: data.email, name: data.name };
}

// ── 小道具 ─────────────────────────────────────────────

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// base64url（UTF-8対応）。
function b64urlEncode(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += "=".repeat(pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function parseCookies(str) {
  const out = {};
  str.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function clearCookie(name) {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
