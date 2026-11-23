// The MCP servers Penelope can use (beta), each attached by the user under Tools in her bubble. clai
// reaches a server at `url` under the name `id`, as a clai mcpServers file of that name would. The
// sign-in is OAuth in the page (discovery, registration, PKCE); what it yields is clai's own token
// store entry for the server (components/clai/architecture/mcp.md, Credential sources), which
// clai sends and refreshes, so the server needs no `auth` block.
import { sha256Hex } from "./providers.js";

export const MCP_SERVERS = [
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", what: "issues, projects and comments" },
];

export const mcpServerById = (id) => MCP_SERVERS.find((s) => s.id === id) ?? null;

export const STORED_MCP = "minutes.mcp";

// What this browser keeps: the servers attached, each server's sign-in ({ entry, revoke }) and the
// OAuth clients registered, by "<issuer> <callback>". Anything else reads as nothing kept.
export function mcpState(text) {
  let kept = null;
  try {
    kept = JSON.parse(text ?? "null");
  } catch {
    // Nothing usable was kept.
  }
  const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  const signins = Object.fromEntries(Object.entries(object(kept?.signins))
    .filter(([id, s]) => mcpServerById(id) && typeof s?.entry?.access_token === "string"));
  const attached = (Array.isArray(kept?.attached) ? kept.attached : []).filter((id) => signins[id]);
  return { attached: [...new Set(attached)], signins, clients: object(kept?.clients) };
}

// The file clai keeps `id`'s token store entry in, in its mcpAuth directory: <sha256 of the server name>.json.
export async function tokenName(id) {
  return `${await sha256Hex(id)}.json`;
}

// Penelope's profile with `servers` added. Each is optional: one that fails to start leaves her
// without its tools, not without an answer.
export function withServers(profile, servers) {
  if (servers.length === 0) return profile;
  const p = JSON.parse(profile);
  p.mcp_servers = { ...p.mcp_servers, ...Object.fromEntries(servers.map((s) => [s.id, { url: s.url, optional: true }])) };
  return JSON.stringify(p, null, 2);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// An endpoint a sign-in may use: https, or http on this machine's loopback.
function endpoint(value, what) {
  let url = null;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} is not a URL (${value ?? "none given"})`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new Error(`${what} is not https (${url.href})`);
  return url.href;
}

// RFC 9728 §3.1 and RFC 8414 §3.1: the well-known name goes between the host and the path.
export function wellKnown(url, name) {
  const u = new URL(url);
  return `${u.origin}/.well-known/${name}${u.pathname.replace(/\/$/, "")}`;
}

// Whether a protected resource `resource` covers the server at `url`: its origin, and its path or one under it.
export function covers(resource, url) {
  try {
    const r = new URL(resource);
    const u = new URL(url);
    const path = r.pathname.replace(/\/$/, "");
    return r.origin === u.origin && (u.pathname === path || u.pathname.startsWith(`${path}/`));
  } catch {
    return false;
  }
}

async function bodyOf(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

// The reason a refusal gives: an OAuth error's description, or the start of its text.
function refusal(response, { json, text }) {
  const said = json?.error_description ?? json?.error ?? text.trim().slice(0, 200);
  return `${response.status}${said ? `: ${said}` : ""}`;
}

async function getJson(url, what, fetchFn) {
  let response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(`could not reach ${what} (${error.message})`);
  }
  const body = await bodyOf(response);
  if (!response.ok) throw new Error(`${what} answered ${refusal(response, body)}`);
  if (!body.json) throw new Error(`${what} is not JSON`);
  return body.json;
}

// Where `server` signs in: its protected-resource document names the authorization server, whose
// own document names the endpoints. Each document must be about what it was fetched for.
export async function discover(server, fetchFn = fetch) {
  const prm = await getJson(wellKnown(server.url, "oauth-protected-resource"), `${server.name}'s resource document`, fetchFn);
  if (typeof prm.resource !== "string" || !covers(prm.resource, server.url)) {
    throw new Error(`${server.name}'s resource document is for ${prm.resource ?? "nothing"}, not ${server.url}`);
  }
  const issuer = endpoint(prm.authorization_servers?.[0], `${server.name}'s sign-in server`);
  const as = await getJson(wellKnown(issuer, "oauth-authorization-server"), `${server.name}'s sign-in server`, fetchFn);
  if (typeof as.issuer !== "string" || as.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
    throw new Error(`${server.name}'s sign-in server says it is ${as.issuer ?? "nobody"}, not ${issuer}`);
  }
  if (!as.code_challenge_methods_supported?.includes("S256")) throw new Error(`${server.name}'s sign-in server does not take PKCE (S256)`);
  return {
    issuer: as.issuer,
    resource: prm.resource,
    scopes: Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((s) => typeof s === "string") : [],
    authorize: endpoint(as.authorization_endpoint, `${server.name}'s authorization endpoint`),
    token: endpoint(as.token_endpoint, `${server.name}'s token endpoint`),
    register: endpoint(as.registration_endpoint, `${server.name}'s registration endpoint`),
    revoke: as.revocation_endpoint ? endpoint(as.revocation_endpoint, `${server.name}'s revocation endpoint`) : null,
  };
}

// Registers Penelope as a public OAuth client whose sign-ins come back to `callback` (RFC 7591).
export async function register(meta, callback, fetchFn = fetch) {
  const response = await fetchFn(meta.register, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Penelope",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await bodyOf(response);
  if (!response.ok || typeof body.json?.client_id !== "string") throw new Error(`the sign-in server did not register Penelope (${refusal(response, body)})`);
  return { id: body.json.client_id, secret: typeof body.json.client_secret === "string" ? body.json.client_secret : null };
}

// The sign-in page's URL: an authorization-code request with PKCE, for the server's resource.
export function signinUrl(meta, { clientId, callback, challenge, state }) {
  const url = new URL(meta.authorize);
  const params = {
    response_type: "code", client_id: clientId, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", state,
    resource: meta.resource, ...(meta.scopes.length > 0 ? { scope: meta.scopes.join(" ") } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

// clai's token store entry for a token response, as mcpauth.TokenEntry reads it; a token with no
// expiry gets Go's zero time, which clai reads as one that never expires.
export function tokenEntry(meta, client, token, now) {
  return {
    issuer: meta.issuer,
    resource: meta.resource,
    client_id: client.id,
    ...(client.secret ? { client_secret: client.secret } : {}),
    access_token: token.access_token,
    ...(typeof token.refresh_token === "string" && token.refresh_token ? { refresh_token: token.refresh_token } : {}),
    expires_at: token.expires_in > 0 ? new Date(now + token.expires_in * 1000).toISOString() : "0001-01-01T00:00:00Z",
    scopes: typeof token.scope === "string" ? token.scope.split(" ").filter(Boolean) : meta.scopes,
  };
}

// Trades the callback's code, with the verifier of the challenge sent, for the server's tokens.
export async function exchangeSignin(meta, { code, verifier, client, callback }, fetchFn = fetch, now = Date.now()) {
  const form = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: callback, client_id: client.id, code_verifier: verifier, resource: meta.resource,
  });
  if (client.secret) form.set("client_secret", client.secret);
  const response = await fetchFn(meta.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const body = await bodyOf(response);
  if (!response.ok || body.json?.error || typeof body.json?.access_token !== "string") throw new Error(`the sign-in was refused (${refusal(response, body)})`);
  return tokenEntry(meta, client, body.json, now);
}

// Revokes a sign-in's refresh token, or its access token when it has none (RFC 7009); whether the
// server said it did.
export async function revokeSignin({ entry, revoke }, fetchFn = fetch) {
  if (!revoke) return false;
  const [token, hint] = entry.refresh_token ? [entry.refresh_token, "refresh_token"] : [entry.access_token, "access_token"];
  const form = new URLSearchParams({ token, token_type_hint: hint, client_id: entry.client_id });
  if (entry.client_secret) form.set("client_secret", entry.client_secret);
  try {
    const response = await fetchFn(revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    return response.ok;
  } catch {
    return false;
  }
}
