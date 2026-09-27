#!/usr/bin/env node
// Verifies the package's public surface: what npm would actually publish,
// and that no file in the shipped doc/workflow/script surface leaks a
// secret-shaped string, an email address, or a local absolute path.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

let failed = false;

function fail(message) {
  console.error(`[public-surface-check] ${message}`);
  failed = true;
}

function packedFiles() {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  return (result.files ?? []).map((entry) => entry.path);
}

function checkRequiredPackagedPaths(files) {
  const required = ["dist/", "README.md", "SECURITY.md", "LICENSE"];
  for (const prefix of required) {
    const present = files.some((file) => file === prefix.replace(/\/$/, "") || file.startsWith(prefix));
    if (!present) {
      fail(`required packaged path missing from "npm pack --dry-run": ${prefix}`);
    }
  }
}

function walk(root) {
  const info = statSync(root, { throwIfNoEntry: false });
  if (!info) return [];
  if (info.isFile()) return [root];
  if (!info.isDirectory()) return [];
  const out = [];
  for (const entry of readdirSync(root)) {
    out.push(...walk(path.join(root, entry)));
  }
  return out;
}

// No trailing \b on the credential pattern: the allowed character class
// ends in punctuation (=, /, ., ~, +, -), and a non-word character right
// before end-of-string is not a word boundary, so a real leaked secret
// ending in base64 padding ("...==") would silently fail to match if a
// trailing \b were required. The leading \b is safe to keep; "vci"/"vcs"
// are always preceded by a non-word character or string start in every
// case this checks.
const FORBIDDEN_CONTENT_PATTERNS = [
  { name: "live-looking Vanta client credential", pattern: /\b(?:vci|vcs)_[A-Za-z0-9._~+/=-]{16,}/ },
  { name: "email address", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: "local absolute path", pattern: /\/Users\/[a-z][a-z0-9_-]*(?:\/|\b)/ },
];

function checkForbiddenContent() {
  // scripts/ is scanned in full, this file included: it must therefore
  // never itself contain a live-looking credential, email, or local path.
  const scanTargets = ["README.md", "SECURITY.md", "package.json", "scripts", "skills", ".github"];
  const files = scanTargets.flatMap((target) => walk(path.join(repoRoot, target)));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { name, pattern } of FORBIDDEN_CONTENT_PATTERNS) {
      if (pattern.test(text)) {
        fail(`${name} found in ${path.relative(repoRoot, file)}`);
      }
    }
  }
}

const files = packedFiles();
checkRequiredPackagedPaths(files);
checkForbiddenContent();

if (failed) {
  console.error("[public-surface-check] FAILED");
  process.exit(1);
}
console.log("[public-surface-check] ok");
