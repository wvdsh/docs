#!/usr/bin/env node

/**
 * Audit JS SDK (WavedashSDK class) against docs.
 *
 * Parses the generated .d.ts file from the SDK build output for the public API,
 * then scans docs for WavedashJS.xxx references. Unlike the Godot/Unity audits,
 * this requires a local SDK checkout (no GitHub API) because .d.ts is a build artifact.
 *
 * Assumptions:
 * - The SDK repo has a working `npx tsup` build that produces dist/index.d.ts
 * - The .d.ts contains `declare class WavedashSDK extends EventTarget`
 * - Public methods are non-private, non-protected members with `(` (method signature)
 * - Events are `readonly EVENT_NAME: "..."` inside the `Events` property block
 * - Methods marked `@deprecated` in JSDoc are excluded
 * - EventTarget inheritance means `addEventListener` is a valid public method
 *
 * Usage:
 *   node audit/sdk-js.js                 # uses ../sdk-js (builds if needed)
 *   node audit/sdk-js.js /path/to/sdk-js # uses specified local checkout
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { RED, DIM, RESET, resolveLocalRoot, runAudit } from "./utils.js";

// JS audit requires a local checkout (needs to build .d.ts)
const sdkRoot = resolveLocalRoot("sdk-js");
if (!sdkRoot) {
  console.error(`${RED}sdk-js not found locally${RESET}`);
  console.error(`${DIM}Clone it as a sibling directory or pass a path: node audit/sdk-js.js /path/to/sdk-js${RESET}`);
  process.exit(1);
}

// Build .d.ts if missing
const dtsPath = join(sdkRoot, "dist", "index.d.ts");
if (!existsSync(dtsPath)) {
  console.log(`${DIM}Building .d.ts (running npx tsup)...${RESET}`);
  try {
    execFileSync("npx", ["tsup"], { cwd: sdkRoot, stdio: "inherit" });
  } catch {
    console.error(`${RED}Failed to build .d.ts — run 'npx tsup' in ${sdkRoot} manually${RESET}`);
    process.exit(1);
  }
}

const dtsSource = readFileSync(dtsPath, "utf-8");

/**
 * Parse the WavedashSDK class from dist/index.d.ts.
 * The .d.ts has explicit private/protected visibility and preserves @deprecated JSDoc.
 */
function extractAPI(dtsSource) {
  const methods = new Set();
  const events = [];

  // Find the WavedashSDK class declaration
  const classStart = dtsSource.indexOf("declare class WavedashSDK");
  if (classStart === -1) {
    console.error(`${RED}Could not find 'declare class WavedashSDK' in ${dtsPath}${RESET}`);
    process.exit(1);
  }

  // EventTarget inheritance gives us addEventListener
  if (dtsSource.slice(classStart, classStart + 200).includes("extends EventTarget")) {
    methods.add("addEventListener");
  }

  const lines = dtsSource.slice(classStart).split("\n");
  let inEventsBlock = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Track Events: { ... } block for event constant extraction
    if (trimmed.startsWith("Events:")) { inEventsBlock = true; braceDepth = 0; }
    if (inEventsBlock) {
      braceDepth += (trimmed.match(/{/g) || []).length;
      braceDepth -= (trimmed.match(/}/g) || []).length;
      const eventMatch = trimmed.match(/readonly\s+([A-Z][A-Z0-9_]+)\s*:/);
      if (eventMatch) events.push(eventMatch[1]);
      if (braceDepth <= 0 && i > 0) inEventsBlock = false;
      continue;
    }

    // Skip private/protected members
    if (trimmed.startsWith("private ") || trimmed.startsWith("protected ")) continue;

    // Skip @deprecated methods — check preceding JSDoc
    let deprecated = false;
    for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
      const prev = lines[j].trim();
      if (prev === "" || prev.startsWith("*") || prev.startsWith("/**") || prev === "*/") {
        if (prev.includes("@deprecated")) { deprecated = true; break; }
        continue;
      }
      break;
    }
    if (deprecated) continue;

    // Match method signatures: "methodName(" at class member level
    const methodMatch = trimmed.match(/^(\w+)\s*\(/);
    if (methodMatch && methodMatch[1] !== "constructor") {
      methods.add(methodMatch[1]);
    }
  }

  return { methods: [...methods], events };
}

/**
 * Scan docs for WavedashJS.xxx references.
 * Matches both method calls and bare property access (e.g. in prose).
 * Filters out "Events" since WavedashJS.Events.XXX is handled separately.
 */
function extractDocRefs(docs) {
  const methodRefs = new Set();
  const eventRefs = new Set();

  for (const { content } of docs) {
    let m;
    const methodRegex = /WavedashJS\.(\w+)/g;
    while ((m = methodRegex.exec(content)) !== null) {
      if (m[1] !== "Events") methodRefs.add(m[1]);
    }

    const eventRegex = /WavedashJS\.Events\.(\w+)/g;
    while ((m = eventRegex.exec(content)) !== null) eventRefs.add(m[1]);
  }

  return { methodRefs: [...methodRefs], eventRefs: [...eventRefs] };
}

const issues = runAudit({
  name: "JS",
  sdkSources: { [`${sdkRoot} (dist/index.d.ts)`]: dtsSource },
  extractAPI,
  extractDocRefs,
  categories: [
    { label: "Methods", sdkKey: "methods", docKey: "methodRefs" },
    { label: "Events", sdkKey: "events", docKey: "eventRefs" },
  ],
});
process.exit(issues > 0 ? 1 : 0);
