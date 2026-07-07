// Bundles each Lambda entrypoint into dist/<name>/index.js and zips it for Terraform.
// One esbuild bundle per Lambda keeps cold-start small and deps tree-shaken.
//
// Output format is CJS: a bare `index.js` in the Lambda zip is interpreted as CommonJS by the
// Node 20 runtime (there is no package.json `type:module` in the zip), so `exports.handler`
// is what Lambda resolves. esbuild transpiles our ESM source to CJS automatically.
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync, createWriteStream, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = join(root, "dist");
const require = createRequire(import.meta.url);

// Each entry => one deployable Lambda artifact (matched by name in Terraform).
const LAMBDAS = [
  { name: "api-entrypoint", entry: "src/lambdas/api-entrypoint/handler.ts" },
  { name: "auth-login", entry: "src/lambdas/auth-login/handler.ts" },
  { name: "auth-authorizer", entry: "src/lambdas/auth-authorizer/handler.ts" },
  { name: "action-edd", entry: "src/lambdas/action-groups/edd/handler.ts" },
  { name: "action-xship-report", entry: "src/lambdas/action-groups/xship-report/handler.ts" },
  { name: "action-xship-download", entry: "src/lambdas/action-groups/xship-download/handler.ts" },
  { name: "action-relationship", entry: "src/lambdas/action-groups/relationship/handler.ts" },
  { name: "action-db", entry: "src/lambdas/action-groups/db/handler.ts" },
  { name: "action-kb", entry: "src/lambdas/action-groups/kb/handler.ts" },
  { name: "ingest-kb", entry: "src/lambdas/ingest-kb/handler.ts" },
  { name: "dispatch", entry: "src/lambdas/dispatch/handler.ts" },
  { name: "analytics", entry: "src/lambdas/analytics/handler.ts" },
  { name: "report", entry: "src/lambdas/report/handler.ts" },
  { name: "flow-process", entry: "src/lambdas/flow-process/handler.ts" },
  { name: "web-serve", entry: "src/lambdas/web-serve/handler.ts" },
  // One-off migration Lambda: bundles db/schema.sql (copied in below) and applies it in-VPC.
  { name: "db-migrate", entry: "src/lambdas/db-migrate/handler.ts", assets: [["db/schema.sql", "schema.sql"]] },
];

// AWS SDK v3 is provided by the Node 20 Lambda runtime — keep it external.
// `pg` IS bundled (it's a dependency): the DB subnets have no NAT/VPC-endpoint to fetch a layer at
// runtime, so the driver must ship inside the zip. It's still imported lazily in code, so the
// in-memory paths never touch it. Its optional native/edge backends are excluded — the pure-JS
// driver is guarded behind those requires and we never select them.
const EXTERNAL = ["@aws-sdk/*", "pg-native", "pg-cloudflare"];

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

for (const lambda of LAMBDAS) {
  const outdir = join(distDir, lambda.name);
  await build({
    entryPoints: [join(root, lambda.entry)],
    outfile: join(outdir, "index.js"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    minify: true,
    external: EXTERNAL,
    logLevel: "info",
  });
  // Mark the bundle as CommonJS explicitly. The repo's root package.json is `type:module`,
  // so without this a bare index.js would be misread as ESM both locally and could be ambiguous.
  writeFileSync(join(outdir, "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
  // Copy any non-code assets (e.g. schema.sql) into the bundle dir so they're zipped alongside index.js.
  for (const [src, dest] of lambda.assets ?? []) {
    copyFileSync(join(root, src), join(outdir, dest));
  }
  await zipDir(outdir, join(distDir, `${lambda.name}.zip`));
  console.log(`packaged ${lambda.name} -> dist/${lambda.name}.zip`);
}

async function zipDir(srcDir, outZip) {
  // Prefer archiver (cross-platform, a declared devDependency); fall back to system zip.
  let archiver = null;
  try {
    archiver = require("archiver");
  } catch {
    archiver = null;
  }
  if (!archiver) {
    const { execSync } = await import("node:child_process");
    if (!existsSync(srcDir)) return;
    execSync(`zip -j -r "${outZip}" "${srcDir}"`, { stdio: "inherit" });
    return;
  }
  await new Promise((res, rej) => {
    const output = createWriteStream(outZip);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", res);
    archive.on("error", rej);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}
