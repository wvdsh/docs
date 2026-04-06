#!/usr/bin/env node

import { execFileSync } from "child_process";
import { join } from "path";
import { parseArgs } from "util";

const dir = new URL(".", import.meta.url).pathname;

const { values } = parseArgs({
  options: {
    godot: { type: "string" },
    unity: { type: "string" },
    js:    { type: "string" },
  },
  strict: false,
});

const scripts = [
  { file: "sdk-godot.js", localRoot: values.godot },
  { file: "sdk-unity.js", localRoot: values.unity },
  { file: "sdk-js.js",    localRoot: values.js },
];

let failed = false;

for (const { file, localRoot } of scripts) {
  const args = [join(dir, file)];
  if (localRoot) args.push(localRoot);
  try {
    execFileSync("node", args, { stdio: "inherit" });
  } catch {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
