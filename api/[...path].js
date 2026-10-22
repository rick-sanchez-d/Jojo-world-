const crypto = require("crypto");
const KEY = process.env.API_KEY, SEASON = process.env.SEASON || 2026, SECRET = process.env.SECRET || "dev-secret";
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const TTL = { live: 90e3, fixtures: 120e3, stats: 300e3, events: 120e3, standings: 900e3 };
const cache = new Map(), hits = new Map();

async function api(endpoint, ttl) {
  const hit = cache.get(endpoint);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  try {
    const d = await (await fetch("https://v3.football.api-sports.io" + endpoint, { headers: { "x-apisports-key": KEY || "" } })).json();
    if (!d.errors || !Object.keys(d.errors).length) cache.set(endpoint, { t: Date.now(), d });
    else if (hit) return hit.d;
    return d;
  } catch { return hit ? hit.d : { errors: { network: "Could not reach the football data provider" }, response: [] }; }
}
async function redis(...cmd) {
  if (!RURL || !RTOK) throw new Error("no-db");
  const r = await fetch(RURL, { method: "POST", headers: { Authorization: "Bearer " + RTOK }, body: JSON.stringify(cmd) });
  return (await r.json()).result;
}
const getUser = async n => { const v = await redis("GET", "user:" + n); return v ? JSON.parse(v) : null; };
const putUser = (n, u) => redis("SET", "user:" + n, JSON.stringify(u));
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const mac = b => crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
const sign = n => { const b = Buffer.from(JSON.stringify({ n, e: Date.now() + 6048e5 })).toString("base64url"); return b + "." + mac(b); };
function who(req) {
  try { const [b, s] = (req.headers.authorization || "").replace("Bearer ", "").split(".");
    if (!b || s !== mac(b)) return null; const p = JSON.parse(Buffer.from(b, "base64url")); return p.e > Date.now() ? p.n : null; } catch { return null; }
}
module.exports = async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname.replace(/\/$/, ""), q = k => u.searchParams.get(k) || "";
  const send = (c, o) => { res.statusCode = c; res.setHeader("Content-Type", "application/json"); res.setHeader("X-Content-Type-Options", "nosniff"); res.end(JSON.stringify(o)); };
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    if (p === "/api/fixtures") {
      const ids = q("ids").replace(/[^0-9-]/g, "").split("-").filter(Boolean).slice(0, 20).join("-");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q("date")) ? q("date") : new Date().toISOString().slice(0, 10);
      return send(200, await api(ids ? "/fixtures?ids=" + ids : "/fixtures?date=" + date, TTL.fixtures));
    }
    if (p === "/api/live") return send(200, await api("/fixtures?live=all", TTL.live));
    if (p === "/api/stats") return send(200, await api("/fixtures/statistics?fixture=" + +q("id"), TTL.stats));
    if (p === "/api/events") return send(200, await api("/fixtures/events?fixture=" + +q("id"), TTL.events));
    if (p === "/api/standings") return send(200, await api(`/standings?league=${+q("league") || 39}&season=${SEASON}`, TTL.standings));
    if (p === "/api/signup" || p === "/api/login") {
      if (req.method !== "POST") return send(405, { error: "POST only" });
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0], n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
      if (n > 30) return send(429, { error: "Too many attempts, try again later" });
      const { name, pass } = body;
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name || "") || !pass || pass.length < 6) return send(400, { error: "Username: 3-20 letters/numbers. Password: 6+ characters." });
      let user = await getUser(name);
      if (p === "/api/signup") {
        if (user) return send(409, { error: "Username taken" });
        const salt = crypto.randomBytes(16).toString("hex"); user = { salt, hash: hash(pass, salt), favs: [] }; await putUser(name, user);
      } else if (!user || user.hash !== hash(pass, user.salt)) return send(401, { error: "Wrong username or password" });
      return send(200, { token: sign(name), name, favs: user.favs });
    }
    if (p === "/api/fav") {
      const n = who(req), user = n && await getUser(n); if (!user) return send(401, { error: "Sign in first" });
      user.favs = (Array.isArray(body.favs) ? body.favs : []).map(Number).filter(Boolean).slice(0, 100); await putUser(n, user); return send(200, { ok: 1 });
    }
    if (p === "/api/me") { const n = who(req), user = n && await getUser(n); return user ? send(200, { name: n, favs: user.favs }) : send(401, {}); }
    return send(404, { error: "Not found" });
  } catch (e) { return send(500, { error: e.message === "no-db" ? "Accounts database not set up yet (add Upstash Redis in Vercel)" : "Server error" }); }
};
