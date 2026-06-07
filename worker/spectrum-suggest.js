// Spectrum — suggestion Worker
// Receives { left, right } from the game and opens a pull request that appends the pair
// to the THEMES deck in src/constants.js. You just review the PR and merge it if you like
// it — players never touch GitHub. Paste this into a Cloudflare Worker (dashboard → Quick
// Edit), then add one secret: GITHUB_TOKEN.
//
// The token must be a fine-grained PAT on this repo with:
//   • Contents:      Read and write   (to commit the edited file on a branch)
//   • Pull requests: Read and write   (to open the PR)
//
// Optional var: ALLOW_ORIGIN (your game's origin, e.g. https://frenchfive.github.io).
// Defaults to "*".

const REPO = "FrenchFive/Spectrum_Game";
const BASE = "main";                 // branch to open the PR against
const FILE = "src/constants.js";     // file holding the THEMES deck

const clean = (s) =>
  String(s || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\p{L}\p{N} '’\-&!?.,()/:]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

// UTF-8 safe base64 (constants.js contains characters like ↔ and ’)
const toB64 = (str) => {
  let bin = "";
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromB64 = (b64) => {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!env.GITHUB_TOKEN) return json({ error: "server not configured" }, 500);

    let data;
    try { data = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const left = clean(data.left), right = clean(data.right);
    if (!left || !right || !/\p{L}/u.test(left) || !/\p{L}/u.test(right)) return json({ error: "invalid" }, 422);

    const gh = (path, init = {}) =>
      fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "spectrum-suggest-worker",
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });

    try {
      // 1) read the current deck file (content + blob sha)
      const fileRes = await gh(`/repos/${REPO}/contents/${FILE}?ref=${BASE}`);
      if (!fileRes.ok) return json({ error: "github", step: "read", status: fileRes.status }, 502);
      const file = await fileRes.json();
      const src = fromB64(file.content);

      // 2) locate the THEMES array
      const start = src.indexOf("export const THEMES = [");
      const close = src.indexOf("\n];", start);
      if (start < 0 || close < 0) return json({ error: "deck-not-found" }, 500);

      // 3) duplicate check (case-insensitive, either orientation)
      const arrayBody = src.slice(start, close);
      const existing = [...arrayBody.matchAll(/\[\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\]/g)].map((m) => [norm(m[1]), norm(m[2])]);
      const nl = norm(left), nr = norm(right);
      if (existing.some(([a, b]) => (a === nl && b === nr) || (a === nr && b === nl)))
        return json({ error: "duplicate" }, 409);

      // 4) insert the pair right before the closing bracket
      const line = `\n  [${JSON.stringify(left)}, ${JSON.stringify(right)}],`;
      const updated = src.slice(0, close) + line + src.slice(close);

      // 5) branch off the base head
      const refRes = await gh(`/repos/${REPO}/git/ref/heads/${BASE}`);
      if (!refRes.ok) return json({ error: "github", step: "ref", status: refRes.status }, 502);
      const headSha = (await refRes.json()).object.sha;
      const branch = `spectrum/${slug(left)}-${slug(right)}-${headSha.slice(0, 7)}`;

      const mkRef = await gh(`/repos/${REPO}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha }),
      });
      // 422 = branch already exists (same suggestion already pending) — treat as duplicate
      if (mkRef.status === 422) return json({ error: "duplicate" }, 409);
      if (!mkRef.ok) return json({ error: "github", step: "branch", status: mkRef.status }, 502);

      // 6) commit the edited file on the new branch
      const put = await gh(`/repos/${REPO}/contents/${FILE}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `Add spectrum: ${left} ↔ ${right}`,
          content: toB64(updated),
          sha: file.sha,
          branch,
        }),
      });
      if (!put.ok) return json({ error: "github", step: "commit", status: put.status }, 502);

      // 7) open the pull request
      const prRes = await gh(`/repos/${REPO}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: `🎯 New spectrum: ${left} ↔ ${right}`,
          head: branch,
          base: BASE,
          body: `Community-suggested spectrum, submitted straight from the game.\n\nAdds \`[${JSON.stringify(left)}, ${JSON.stringify(right)}]\` to the \`THEMES\` deck in \`${FILE}\`.\n\nReview the pair and merge it to ship it. 🎯`,
        }),
      });
      if (!prRes.ok) return json({ error: "github", step: "pr", status: prRes.status }, 502);
      const pr = await prRes.json();
      return json({ ok: true, prUrl: pr.html_url });
    } catch (e) {
      return json({ error: "worker", detail: String(e) }, 500);
    }
  },
};
