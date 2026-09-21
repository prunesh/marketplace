const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const MARKETPLACE_REPO = 'prunesh/marketplace';
const OIDC_AUDIENCE = 'prunesh-marketplace';

let jwksCache = null;
let jwksCacheTime = 0;
const JWKS_TTL_MS = 3600 * 1000;

async function fetchJWKS() {
  const now = Date.now();
  if (jwksCache && now - jwksCacheTime < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(GITHUB_JWKS_URL);
  if (!res.ok) throw new Error('Failed to fetch JWKS');
  jwksCache = await res.json();
  jwksCacheTime = now;
  return jwksCache;
}

function base64urlToBytes(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyJWT(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1])));

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('Token expired');
  if (payload.iss !== GITHUB_OIDC_ISSUER) throw new Error(`Invalid issuer: ${payload.iss}`);

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(OIDC_AUDIENCE)) throw new Error(`Invalid audience: ${payload.aud}`);

  const jwks = await fetchJWKS();
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error(`Unknown key id: ${header.kid}`);

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );

  if (!valid) throw new Error('Invalid signature');
  return payload;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (url.pathname !== '/publish') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { oidc_token, plugin_id, version, repo } = body;

    if (!oidc_token || !plugin_id || !version || !repo) {
      return jsonResponse({ error: 'Missing fields: oidc_token, plugin_id, version, repo' }, 400);
    }

    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(plugin_id)) {
      return jsonResponse({ error: 'Invalid plugin_id. Expected format: author/command' }, 400);
    }

    let claims;
    try {
      claims = await verifyJWT(oidc_token);
    } catch (err) {
      return jsonResponse({ error: `OIDC validation failed: ${err.message}` }, 401);
    }

    const tokenRepo = claims.repository;
    const declaredRepo = repo.replace('https://github.com/', '');

    if (tokenRepo !== declaredRepo) {
      return jsonResponse({ error: `Repo mismatch: token=${tokenRepo} declared=${declaredRepo}` }, 403);
    }

    const pluginAuthor = plugin_id.split('/')[0];
    const repoOwner = declaredRepo.split('/')[0];
    if (pluginAuthor !== repoOwner) {
      return jsonResponse({ error: `Plugin author (${pluginAuthor}) must match repo owner (${repoOwner})` }, 403);
    }

    const dispatchRes = await fetch(
      `https://api.github.com/repos/${MARKETPLACE_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.MARKETPLACE_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'prunesh-marketplace-worker/1',
        },
        body: JSON.stringify({
          event_type: 'plugin_publish',
          client_payload: { plugin_id, version, repo },
        }),
      }
    );

    if (!dispatchRes.ok) {
      const text = await dispatchRes.text();
      return jsonResponse({ error: `Dispatch failed: ${text}` }, 502);
    }

    return jsonResponse({ ok: true, plugin_id, version }, 202);
  },
};
