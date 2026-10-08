// Copy the settings the app needs from .env.local into the linked Vercel project (Production), without
// printing them. Run after `vercel link`:   node scripts/push-env-to-vercel.mjs
// Existing values with the same name are replaced.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const KEYS = ["DATABASE_URL", "SECRETS_KEY", "AUTH_SECRET", "CRON_SECRET", "SETUP_TOKEN", "ADMIN_EMAIL", "KIMI_API_KEY", "KIMI_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL"];
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

// DATABASE_URL may live only in Vercel (Neon integration); everything else must be in .env.local.
// One AI provider is enough: Kimi (KIMI_API_KEY) or OpenAI (OPENAI_API_KEY); the model names are optional.
const optional = new Set(["DATABASE_URL", "KIMI_MODEL", "OPENAI_MODEL", env.KIMI_API_KEY ? "OPENAI_API_KEY" : "KIMI_API_KEY"]);
const missing = KEYS.filter((k) => !env[k] && !optional.has(k));
if (missing.length) {
  console.error(`Add these to .env.local first: ${missing.join(", ")}`);
  process.exit(1);
}

// DATABASE_URL is managed by the Neon integration when the database was created from Vercel; leave it alone.
const existing = spawnSync("vercel", ["env", "ls", "production"], { shell: true }).stdout?.toString() ?? "";
for (const key of KEYS) {
  if (key === "DATABASE_URL" && /\bDATABASE_URL\b/.test(existing)) {
    console.log("DATABASE_URL: already set in Vercel (Neon integration), left as is");
    continue;
  }
  spawnSync("vercel", ["env", "rm", key, "production", "--yes"], { shell: true, stdio: "ignore" });
  if (!env[key]) {
    console.log(`${key}: not in .env.local, skipped`);
    continue;
  }
  // The value goes in on stdin with no trailing newline, so it arrives exactly as written.
  const r = spawnSync("vercel", ["env", "add", key, "production"], { shell: true, input: env[key], stdio: ["pipe", "ignore", "pipe"] });
  console.log(`${key}: ${r.status === 0 ? "set" : `failed (${r.stderr.toString().trim().split("\n").pop()})`}`);
}
