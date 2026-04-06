#!/usr/bin/env node

/**
 * Audit Unity SDK against docs.
 *
 * Reads all .cs files in the SDK repo, extracts public static methods and events,
 * then scans docs for Wavedash.SDK.Xxx references.
 *
 * Assumptions:
 * - Public API methods are `public static [async] ReturnType MethodName(`
 * - Events are `public static event Action<...> OnXxx;`
 * - Events follow the `On` prefix convention (OnLobbyJoined, OnP2PConnected, etc.)
 * - Method overloads are deduped (only the name matters, not the signature)
 * - Docs reference methods as `Wavedash.SDK.MethodName`
 * - Docs reference events as `Wavedash.SDK.OnEventName`
 *
 * Usage:
 *   node audit/sdk-unity.js                    # fetch from GitHub
 *   node audit/sdk-unity.js /path/to/sdk-unity # use local checkout
 */

import { resolveLocalRoot, listSdkFiles, readSdkFile, runAudit } from "./utils.js";

const localRoot = resolveLocalRoot("sdk-unity");

// Read all .cs files in the repo
const csFiles = listSdkFiles("sdk-unity", ".cs", localRoot);
const sources = csFiles.map((f) => readSdkFile("sdk-unity", f, localRoot));
const allSource = sources.join("\n");

/** Parse all .cs files for public static methods and events. */
function extractAPI(source) {
  const methods = new Set();
  const events = [];

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    // Events: "public static event Action<...> OnXxx;"
    const eventMatch = trimmed.match(/^public\s+static\s+event\s+.+\s+(\w+)\s*;/);
    if (eventMatch) { events.push(eventMatch[1]); continue; }

    // Methods: "public static [async] ReturnType MethodName("
    // Guard against multi-line event declarations that contain " event "
    if (trimmed.startsWith("public static") && !trimmed.includes(" event ")) {
      const methodMatch = trimmed.match(
        /^public\s+static\s+(?:async\s+)?(?:.+?\s+)(\w+)\s*\(/
      );
      if (methodMatch) methods.add(methodMatch[1]);
    }
  }

  return { methods: [...methods], events };
}

/**
 * Scan docs for Wavedash.SDK.Xxx references.
 * Methods and events are distinguished by the "On" prefix convention.
 */
function extractDocRefs(docs) {
  const methodRefs = new Set();
  const eventRefs = new Set();

  for (const { content } of docs) {
    let m;

    // Match any Wavedash.SDK.Xxx reference
    const methodRegex = /Wavedash\.SDK\.(\w+)/g;
    while ((m = methodRegex.exec(content)) !== null) {
      // Events start with "On" (e.g. OnLobbyJoined)
      if (!m[1].startsWith("On")) methodRefs.add(m[1]);
    }

    // Events: Wavedash.SDK.OnXxx (subscriptions, unsubscriptions, or prose refs)
    const eventRegex = /Wavedash\.SDK\.(On\w+)/g;
    while ((m = eventRegex.exec(content)) !== null) eventRefs.add(m[1]);
  }

  return { methodRefs: [...methodRefs], eventRefs: [...eventRefs] };
}

const label = localRoot || "github.com/wvdsh/sdk-unity (main)";

const issues = runAudit({
  name: "Unity",
  sdkSources: { [`${label} (${csFiles.length} .cs files)`]: allSource },
  extractAPI,
  extractDocRefs,
  categories: [
    { label: "Methods", sdkKey: "methods", docKey: "methodRefs" },
    { label: "Events", sdkKey: "events", docKey: "eventRefs" },
  ],
});
process.exit(issues > 0 ? 1 : 0);
