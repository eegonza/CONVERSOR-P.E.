import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = new URL("./", import.meta.url);
const root = new URL("../", here);
const dist = new URL("./dist/", here);
const path = fileURLToPath;

const url = new URL(process.env.SUPABASE_URL || "https://xvjscltcvanrwqmgfcey.supabase.co");
const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
if (url.href !== url.origin + "/" || (!loopback && url.protocol !== "https:")) {
  throw new Error("SUPABASE_URL debe ser el origen HTTPS del proyecto Supabase.");
}

const publishable = (process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
if (publishable && !/^sb_publishable_[a-zA-Z0-9_-]{10,128}$/.test(publishable)) {
  let role;
  try {
    role = JSON.parse(Buffer.from(publishable.split(".")[1], "base64url")).role;
  } catch {
    // Reject malformed or non-publishable credentials below.
  }
  if (role !== "anon" || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(publishable)) {
    throw new Error("Usa una clave publicable de Supabase o la clave heredada anon.");
  }
}

await mkdir(new URL("./assets/", dist), { recursive: true });
execFileSync(process.env.PYTHON || "python3", [
  path(new URL("./build_runtime.py", here)),
  path(new URL("./runtime/", dist)),
], { stdio: "inherit" });

const staticSource = new URL("./conversor/static/", root);
await copyFile(new URL("./styles.css", staticSource), new URL("./assets/styles.css", dist));
await copyFile(new URL("./runtime-worker.mjs", here), new URL("./assets/runtime-worker.mjs", dist));
await build({
  entryPoints: [path(new URL("./transport.mjs", here))],
  outfile: path(new URL("./assets/transport.js", dist)),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  define: {
    CONVERSOR_SUPABASE_URL: JSON.stringify(url.origin),
    CONVERSOR_PUBLISHABLE_KEY: JSON.stringify(publishable),
  },
});

const revision = createHash("sha256");
for (const asset of ["assets/styles.css", "assets/transport.js", "assets/runtime-worker.mjs", "runtime/conversor.zip"]) {
  revision.update(await readFile(new URL(asset, dist)));
}
const version = `?v=${revision.digest("hex").slice(0, 16)}`;
const html = await readFile(new URL("./index.html", staticSource), "utf8");
const policy = `default-src 'self'; base-uri 'none'; connect-src 'self' ${url.origin}; script-src 'self' 'wasm-unsafe-eval'; frame-src blob:; worker-src 'self'; img-src 'self' data: blob:; object-src 'none'; form-action 'none'`;
const entry = html
  .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n    <meta http-equiv="Content-Security-Policy" content="${policy}">\n    <meta name="referrer" content="no-referrer">`)
  .replace('href="/static/styles.css"', `href="./assets/styles.css${version}"`)
  .replace('<script src="/static/app.js" defer></script>', `<script src="./assets/transport.js${version}" type="module"></script>`);
if (entry.includes('src="/static/') || !entry.includes("./assets/transport.js")) {
  throw new Error("No se pudo adaptar el documento inicial para GitHub Pages.");
}
await writeFile(new URL("./index.html", dist), entry);
await writeFile(new URL("./.nojekyll", dist), "");
