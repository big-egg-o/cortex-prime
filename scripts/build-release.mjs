/**
 * Build the release package for a version tag.
 *
 * Produces dist/system.zip (the installable system) and dist/system.json (the manifest,
 * stamped with version, manifest and download URLs). Only an explicit allowlist of folders
 * is packaged, so reference/, tests/, tooling and node_modules never ship.
 *
 * Usage: node scripts/build-release.mjs v1.2.3   (CI passes the pushed tag; needs the `zip` CLI)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO = process.env.GITHUB_REPOSITORY ?? "big-egg-o/cortex-prime";
const INCLUDE = ["module", "templates", "styles", "lang", "assets", "packs", "README.md", "LICENSE"];
const DIST = "dist";
const STAGE = join(DIST, "package");

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if ( !match ) throw new Error(`Expected a tag like v1.2.3, got "${tag}"`);
const version = match[1];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for ( const entry of INCLUDE ) {
  if ( existsSync(entry) ) cpSync(entry, join(STAGE, entry), { recursive: true, filter: src => !src.endsWith(".gitkeep") });
}

const manifest = JSON.parse(readFileSync("system.json", "utf8"));
manifest.version = version;
manifest.manifest = `https://github.com/${REPO}/releases/latest/download/system.json`;
manifest.download = `https://github.com/${REPO}/releases/download/${tag}/system.zip`;

// Every file the manifest references must be inside the package.
const referenced = [
  ...(manifest.esmodules ?? []),
  ...(manifest.styles ?? []).map(style => (typeof style === "string" ? style : style.src)),
  ...(manifest.languages ?? []).map(language => language.path)
];
const missing = referenced.filter(path => !existsSync(join(STAGE, path)));
if ( missing.length ) throw new Error(`Referenced by system.json but not packaged: ${missing.join(", ")}`);

const json = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(STAGE, "system.json"), json);
writeFileSync(join(DIST, "system.json"), json);
execFileSync("zip", ["-r", "-q", "../system.zip", "."], { cwd: STAGE, stdio: "inherit" });
console.log(`Built ${DIST}/system.zip and ${DIST}/system.json for ${manifest.id} ${version}`);
