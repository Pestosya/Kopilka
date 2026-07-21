import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
const files = [
  "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "service-worker.js", "icon.svg", "icon-192.png", "icon-512.png",
  "apple-touch-icon.png", "modules/migrations.js", "modules/finance.js",
  "modules/security.js", "modules/sync.js"
];

function validSupabaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".supabase.co");
  } catch {
    return false;
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of files) {
  const target = join(output, file);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, file), target);
}

// Public browser credentials. They are environment-specific, but are not secrets:
// access to user rows is enforced by Supabase Auth and RLS.
const fallbackConfig = await readFile(join(root, "sync-config.js"), "utf8");
const fallbackUrl = fallbackConfig.match(/url:\s*["']([^"']+)/)?.[1] || "";
const fallbackKey = fallbackConfig.match(/publishableKey:\s*["']([^"']+)/)?.[1] || "";
const url = process.env.KOPILKA_SUPABASE_URL || fallbackUrl;
const publishableKey = process.env.KOPILKA_SUPABASE_PUBLISHABLE_KEY || fallbackKey;

if (!validSupabaseUrl(url)) throw new Error("KOPILKA_SUPABASE_URL must be a valid https://*.supabase.co URL");
if (!/^(sb_publishable_|eyJ)/.test(publishableKey)) {
  throw new Error("KOPILKA_SUPABASE_PUBLISHABLE_KEY must be a publishable/anon key");
}

await writeFile(join(output, "sync-config.js"),
  `window.KOPILKA_SYNC_CONFIG = ${JSON.stringify({ url, publishableKey, enabled: true }, null, 2)};\n`
);

// Each deployment gets a fresh cache namespace derived from its actual assets.
const fingerprint = createHash("sha256");
for (const file of files.filter(file => file !== "service-worker.js")) {
  fingerprint.update(await readFile(join(output, file)));
}
fingerprint.update(url).update(publishableKey);
const cacheVersion = fingerprint.digest("hex").slice(0, 12);
const workerPath = join(output, "service-worker.js");
const worker = await readFile(workerPath, "utf8");
await writeFile(workerPath, worker.replace(/const CACHE = [^;]+;/, `const CACHE = "kopilka-${cacheVersion}";`));

await writeFile(join(output, "health.json"), JSON.stringify({ status: "ok" }) + "\n");
console.log(`Built production artifact: dist/ (cache ${cacheVersion})`);
