import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outExtension: () => ({ js: ".mjs" }),
  define: {
    __AGENTPACK_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0-dev"),
  },
  banner: {
    // createRequire shim: bundled CJS deps (commander) call require() for
    // node builtins, which plain ESM output does not provide.
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  // Bundle every dependency (workspace packages and their deps) into one file.
  noExternal: [
    "@agentpack/core",
    "@agentpack/schema",
    "@agentpack/filesystem",
    "@agentpack/adapter-codex",
    "@agentpack/adapter-claude",
    "@agentpack/adapter-kimi",
    "@agentpack/adapter-ext",
    "@agentpack/gateway",
    "@clack/prompts",
    "commander",
    "yaml",
    "zod",
    "smol-toml",
  ],
  sourcemap: false,
  minify: false,
  clean: true,
  onSuccess: "chmod +x dist/cli.mjs",
});
