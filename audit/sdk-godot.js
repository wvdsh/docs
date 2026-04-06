#!/usr/bin/env node

/**
 * Audit Godot SDK against docs.
 *
 * Reads all .gd files in the SDK repo, extracts public methods (non-underscore func)
 * and signals, then scans docs for WavedashSDK.xxx references.
 *
 * Assumptions:
 * - Public methods are top-level `func xxx(` without underscore prefix
 * - Private methods start with `_` (GDScript convention)
 * - Signals are declared with the `signal` keyword
 * - Docs reference methods as `WavedashSDK.method_name` (with or without parens)
 * - Docs reference signals as `WavedashSDK.signal_name.connect(`
 * - References shorter than 3 chars are ignored (avoids matching filename WavedashSDK.gd)
 *
 * Usage:
 *   node audit/sdk-godot.js                    # fetch from GitHub
 *   node audit/sdk-godot.js /path/to/sdk-godot # use local checkout
 */

import { resolveLocalRoot, listSdkFiles, readSdkFile, runAudit } from "./utils.js";

const localRoot = resolveLocalRoot("sdk-godot");

// Read all .gd files in the repo
const gdFiles = listSdkFiles("sdk-godot", ".gd", localRoot);
const sources = gdFiles.map((f) => readSdkFile("sdk-godot", f, localRoot));
const allSource = sources.join("\n");

/** Parse all .gd files for public methods and signals. */
function extractAPI(source) {
  const methods = [];
  const signals = [];

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    // Signals: "signal lobby_joined(payload)"
    const sigMatch = trimmed.match(/^signal\s+(\w+)/);
    if (sigMatch) { signals.push(sigMatch[1]); continue; }

    // Public methods: "func xxx(" — skip private (underscore-prefixed)
    const funcMatch = trimmed.match(/^func\s+(\w+)\s*\(/);
    if (funcMatch && !funcMatch[1].startsWith("_")) {
      methods.push(funcMatch[1]);
    }
  }

  return { methods, signals };
}

/**
 * Scan docs for WavedashSDK.xxx references.
 * Matches both method calls (with parens) and bare references (in prose).
 * Signals are identified by .connect() / .emit() patterns and removed from methods.
 * Requires 3+ chars to avoid matching the filename "WavedashSDK.gd".
 */
function extractDocRefs(docs) {
  const methodRefs = new Set();
  const signalRefs = new Set();

  for (const { content } of docs) {
    let m;

    // Broad match: any WavedashSDK.xxx reference (methods + signals)
    const methodRegex = /WavedashSDK\.(\w{3,})/g;
    while ((m = methodRegex.exec(content)) !== null) methodRefs.add(m[1]);

    // Signal connections: WavedashSDK.signal_name.connect(handler)
    const signalRegex = /WavedashSDK\.(\w+)\.connect\s*\(/g;
    while ((m = signalRegex.exec(content)) !== null) signalRefs.add(m[1]);

    // Signal emissions: WavedashSDK.signal_name.emit(payload)
    const emitRegex = /WavedashSDK\.(\w+)\.emit\s*\(/g;
    while ((m = emitRegex.exec(content)) !== null) signalRefs.add(m[1]);
  }

  // The broad regex catches signal names too — remove them from methods
  for (const sig of signalRefs) methodRefs.delete(sig);

  return { methodRefs: [...methodRefs], signalRefs: [...signalRefs] };
}

const label = localRoot || "github.com/wvdsh/sdk-godot (main)";

const issues = runAudit({
  name: "Godot",
  sdkSources: { [`${label} (${gdFiles.length} .gd files)`]: allSource },
  extractAPI,
  extractDocRefs,
  categories: [
    { label: "Methods", sdkKey: "methods", docKey: "methodRefs" },
    { label: "Signals", sdkKey: "signals", docKey: "signalRefs" },
  ],
});
process.exit(issues > 0 ? 1 : 0);
