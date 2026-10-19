// Assembles the installable web app into _site/ (published to GitHub Pages).
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const out = "_site";
const version = process.env.GITHUB_RUN_NUMBER || `dev-${Date.now()}`;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync("web")) fs.cpSync(path.join("web", f), path.join(out, f), { recursive: true });

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "iife",
  target: ["chrome110", "edge110"],
  minify: true,
  sourcemap: false,
  legalComments: "linked",
  outfile: path.join(out, "app.js"),
});

const sw = path.join(out, "sw.js");
fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace("__BUILD__", version));
fs.writeFileSync(path.join(out, ".nojekyll"), "");
fs.writeFileSync(path.join(out, "version.txt"), version + "\n");
console.log(`Built Pixel Control (build ${version}) into ${out}/`);
