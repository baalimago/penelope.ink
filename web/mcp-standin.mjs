// A stand-in for an MCP server that signs in with OAuth, as mcp.linear.app does: its two discovery
// documents, client registration, a sign-in page that approves at once, a token endpoint (codes,
// refreshes and revocations) and the MCP endpoint, which answers only a token it issued, keeps a
// session as a session-bearing server does, and has one tool, list_issues. `handle` takes a
// request ({ method, url, headers, body }, headers in lower case) and returns { status, headers,
// body }; `seen` is what it was sent.
import { createHash } from "node:crypto";

export const STANDIN_ISSUE = "LIN-7 Ship Penelope's tools (In Progress)";

export function mcpStandIn(origin = "https://mcp.linear.app") {
  const seen = { registered: [], authorized: [], grants: [], revoked: [], calls: [], problems: [] };
  const codes = new Map();
  const live = new Set();
  const refreshes = new Map();
  let issued = 0;
  const session = "standin-session";
  const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url");
  const cors = (headers) => ({
    "access-control-allow-origin": headers.origin ?? "*",
    "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-expose-headers": "mcp-session-id, www-authenticate",
  });
  const json = (headers, status, body, extra = {}) => ({
    status, headers: { ...cors(headers), "content-type": "application/json", ...extra }, body: JSON.stringify(body),
  });
  const tokens = () => {
    issued += 1;
    const access = `standin-access-${issued}`;
    const refresh = `standin-refresh-${issued}`;
    live.add(access);
    refreshes.set(refresh, access);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: "read write" };
  };

  function token(headers, form) {
    if (form.has("token")) {
      seen.revoked.push(Object.fromEntries(form));
      live.delete(refreshes.get(form.get("token")));
      refreshes.delete(form.get("token"));
      return { status: 200, headers: cors(headers), body: "" };
    }
    seen.grants.push(Object.fromEntries(form));
    if (form.get("grant_type") === "refresh_token") {
      const old = refreshes.get(form.get("refresh_token"));
      if (!old) return json(headers, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
      live.delete(old);
      refreshes.delete(form.get("refresh_token"));
      return json(headers, 200, tokens());
    }
    const code = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    const wrong = !code ? "unknown code"
      : code.client !== form.get("client_id") ? "another client's code"
      : code.redirect !== form.get("redirect_uri") ? "another redirect_uri"
      : code.challenge !== challengeOf(form.get("code_verifier") ?? "") ? "the verifier does not prove the challenge"
      : form.get("resource") !== `${origin}/mcp` ? `resource ${form.get("resource")}`
      : null;
    if (wrong) {
      seen.problems.push(`token: ${wrong}`);
      return json(headers, 400, { error: "invalid_grant", error_description: wrong });
    }
    return json(headers, 200, tokens());
  }

  function mcp(headers, message) {
    if (!live.has((headers.authorization ?? "").replace(/^Bearer /, ""))) {
      return json(headers, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
    }
    if (message.method !== "initialize" && headers["mcp-session-id"] !== session) {
      seen.problems.push(`mcp: ${message.method} without the session id`);
      return json(headers, 400, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: "no valid session id" } });
    }
    if (message.id === undefined) return { status: 202, headers: cors(headers), body: "" };
    const answer = (result) => json(headers, 200, { jsonrpc: "2.0", id: message.id, result }, message.method === "initialize" ? { "mcp-session-id": session } : {});
    switch (message.method) {
      case "initialize":
        return answer({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "linear-standin", version: "1" } });
      case "tools/list":
        return answer({
          tools: [{
            name: "list_issues",
            description: "List the user's Linear issues.",
            inputSchema: { type: "object", properties: { query: { type: "string", description: "Words the issues hold." } } },
          }],
        });
      case "tools/call":
        seen.calls.push({ name: message.params?.name, arguments: message.params?.arguments ?? {}, bearer: headers.authorization });
        return answer({ content: [{ type: "text", text: STANDIN_ISSUE }] });
      default:
        return json(headers, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
    }
  }

  function handle({ method, url, headers, body }) {
    const u = new URL(url);
    if (method === "OPTIONS") return { status: 204, headers: cors(headers), body: "" };
    switch (`${method} ${u.pathname}`) {
      case "GET /.well-known/oauth-protected-resource/mcp":
        return json(headers, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"] });
      case "GET /.well-known/oauth-authorization-server":
        return json(headers, 200, {
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/token`, code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"],
          response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"],
        });
      case "POST /register": {
        const client = JSON.parse(body || "{}");
        seen.registered.push(client);
        return json(headers, 201, { client_id: `standin-client-${seen.registered.length}`, redirect_uris: client.redirect_uris, token_endpoint_auth_method: "none" });
      }
      case "GET /authorize": {
        const q = u.searchParams;
        seen.authorized.push(Object.fromEntries(q));
        const back = new URL(q.get("redirect_uri"));
        const code = `standin-code-${seen.authorized.length}`;
        codes.set(code, { client: q.get("client_id"), redirect: q.get("redirect_uri"), challenge: q.get("code_challenge") });
        back.search = new URLSearchParams({ code, state: q.get("state") ?? "", iss: origin }).toString();
        return { status: 302, headers: { location: back.href }, body: "" };
      }
      case "POST /token":
        return token(headers, new URLSearchParams(body ?? ""));
      case "POST /mcp":
        return mcp(headers, JSON.parse(body || "{}"));
      case "GET /mcp":
        return { status: 405, headers: cors(headers), body: "" };
      case "DELETE /mcp":
        return { status: 200, headers: cors(headers), body: "" };
      default:
        return { status: 404, headers: cors(headers), body: "not found" };
    }
  }

  return { handle, seen };
}
