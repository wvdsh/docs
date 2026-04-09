/**
 * Shared utilities for SDK documentation audits.
 *
 * Each SDK audit script (sdk-godot.js, sdk-unity.js, sdk-js.js) extracts
 * the public API surface from its SDK source code, then scans all .mdx doc
 * files for references to that API. The runAudit() function compares the two
 * sets and reports undocumented APIs and stale doc references.
 *
 * SDK sources are fetched from GitHub by default (latest main branch).
 * Pass a local path as a CLI arg to audit against a local checkout instead.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, relative, resolve } from "path";

// Terminal colors for output
export const RED    = "\x1b[31m";
export const GREEN  = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN   = "\x1b[36m";
export const BOLD   = "\x1b[1m";
export const DIM    = "\x1b[2m";
export const RESET  = "\x1b[0m";

// Resolved path to the docs repo root (one level up from audit/)
export const DOCS_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// GitHub org that hosts the SDK repos
export const GITHUB_ORG = "wvdsh";

/**
 * Fetch a file from a GitHub repo via the `gh` CLI.
 * Requires `gh` to be installed and authenticated.
 */
function fetchFromGitHub(repo, filePath) {
  const result = execFileSync(
    "gh", ["api", `repos/${GITHUB_ORG}/${repo}/contents/${filePath}`, "--jq", ".content"],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
  return Buffer.from(result.trim(), "base64").toString("utf-8");
}

/**
 * List all files in an SDK repo matching a file extension (e.g. ".gd", ".cs", ".ts").
 * Returns an array of relative file paths.
 */
export function listSdkFiles(repo, ext, localRoot) {
  if (localRoot) {
    const results = [];
    function walk(dir, base) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = base ? `${base}/${entry}` : entry;
        const stat = statSync(full);
        if (stat.isDirectory() && entry !== "node_modules" && entry !== ".git") {
          walk(full, rel);
        } else if (entry.endsWith(ext)) {
          results.push(rel);
        }
      }
    }
    walk(localRoot, "");
    return results;
  }
  // Fetch file tree from GitHub
  try {
    const result = execFileSync(
      "gh", ["api", `repos/${GITHUB_ORG}/${repo}/git/trees/main?recursive=1`,
        "--jq", `.tree[] | select(.type == "blob") | .path`],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim().split("\n").filter((p) => p.endsWith(ext));
  } catch {
    console.error(`${RED}Failed to list files in ${repo} from GitHub${RESET}`);
    process.exit(1);
  }
}

/**
 * Read an SDK source file. Uses local disk if localRoot is provided,
 * otherwise fetches from GitHub (latest main).
 */
export function readSdkFile(repo, filePath, localRoot) {
  if (localRoot) {
    const full = join(localRoot, filePath);
    try {
      return readFileSync(full, "utf-8");
    } catch (err) {
      console.error(`${RED}Error reading ${full}: ${err.message}${RESET}`);
      process.exit(1);
    }
  }
  try {
    return fetchFromGitHub(repo, filePath);
  } catch {
    console.error(`${RED}Failed to fetch ${repo}/${filePath} from GitHub${RESET}`);
    console.error(`${DIM}Make sure 'gh' is installed and authenticated, or pass a local path${RESET}`);
    process.exit(1);
  }
}

/**
 * Resolve the local SDK root. Checks in order:
 * 1. Positional CLI arg (explicit path — errors if not found)
 * 2. Default sibling directory (../repoName from docs root)
 * 3. null (fall back to GitHub API)
 */
export function resolveLocalRoot(repoName) {
  const positional = process.argv[2];
  if (positional) {
    const resolved = resolve(positional);
    if (!existsSync(resolved)) {
      console.error(`${RED}SDK root not found: ${resolved}${RESET}`);
      process.exit(1);
    }
    return resolved;
  }
  const sibling = join(DOCS_ROOT, "..", repoName);
  if (existsSync(sibling)) return resolve(sibling);
  return null;
}

function readFile(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    console.error(`${RED}Error reading ${path}: ${err.message}${RESET}`);
    process.exit(1);
  }
}

/** Recursively collect all .mdx files under a directory. */
function collectMdxFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && entry !== "node_modules" && entry !== ".git") {
      results.push(...collectMdxFiles(full));
    } else if (entry.endsWith(".mdx")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Compare SDK API items against doc references.
 * Returns { undocumented: items in SDK but not docs, stale: items in docs but not SDK }.
 */
function compare(sdkItems, docRefs) {
  const docSet = new Set(docRefs);
  const sdkSet = new Set(sdkItems);
  return {
    undocumented: sdkItems.filter((item) => !docSet.has(item)),
    stale: docRefs.filter((ref) => !sdkSet.has(ref)),
  };
}

/** Print coverage results for one category (e.g. "Methods", "Events"). Returns issue count. */
function printCoverage(label, { undocumented, stale }) {
  if (undocumented.length === 0 && stale.length === 0) {
    console.log(`  ${GREEN}✓${RESET} ${label}: all documented`);
    return 0;
  }

  let issues = 0;

  if (undocumented.length > 0) {
    console.log(`  ${RED}✗${RESET} ${label}: ${RED}${undocumented.length} undocumented${RESET}`);
    for (const item of undocumented) console.log(`      ${DIM}→ ${item}${RESET}`);
    issues += undocumented.length;
  }

  if (stale.length > 0) {
    console.log(`  ${YELLOW}?${RESET} ${label}: ${YELLOW}${stale.length} in docs but not in SDK${RESET}`);
    for (const item of stale) console.log(`      ${DIM}→ ${item}${RESET}`);
    issues += stale.length;
  }

  return issues;
}

/**
 * Run a full audit for one SDK.
 *
 * Each SDK script provides:
 * - extractAPI: parses SDK source → { methods: [], signals/events: [] }
 * - extractDocRefs: scans full .mdx content (not just code blocks) for SDK references
 *   Each SDK has a unique prefix (WavedashSDK., Wavedash.SDK., WavedashJS.)
 *   so we don't need language-specific code block parsing.
 * - categories: maps SDK keys to doc ref keys for comparison
 *
 * Returns total issue count (0 = clean).
 */
export function runAudit({ name, sdkSources, extractAPI, extractDocRefs, categories }) {
  console.log(`\n${BOLD}${CYAN}${name} SDK Documentation Audit${RESET}\n`);
  for (const [label, _] of Object.entries(sdkSources)) {
    console.log(`${DIM}${label}${RESET}`);
  }
  console.log(`${DIM}Docs root: ${DOCS_ROOT}${RESET}\n`);

  // Extract public API from SDK source
  const sources = Object.values(sdkSources);
  const api = extractAPI(...sources);

  const apiParts = categories.map((c) => `${api[c.sdkKey].length} ${c.label.toLowerCase()}`);
  console.log(`${BOLD}SDK API surface:${RESET} ${apiParts.join(", ")}\n`);

  // Read all .mdx files and pass full content to doc ref extractor
  const mdxFiles = collectMdxFiles(DOCS_ROOT);
  const docs = mdxFiles.map((file) => ({
    file: relative(DOCS_ROOT, file),
    content: readFile(file),
  }));
  console.log(`${BOLD}Documentation:${RESET} ${docs.length} .mdx files\n`);

  const docRefs = extractDocRefs(docs);
  const refParts = categories.map((c) => `${docRefs[c.docKey].length} ${c.label.toLowerCase()}`);
  console.log(`${BOLD}Doc references:${RESET} ${refParts.join(", ")}\n`);

  // Compare and report
  console.log(`${BOLD}Coverage:${RESET}`);
  let issues = 0;
  for (const cat of categories) {
    issues += printCoverage(cat.label, compare(api[cat.sdkKey], docRefs[cat.docKey]));
  }

  console.log();
  if (issues === 0) {
    console.log(`${GREEN}${BOLD}All ${name} SDK APIs are documented.${RESET}\n`);
  } else {
    console.log(`${RED}${BOLD}${issues} issue(s) found.${RESET}\n`);
  }
  return issues;
}
