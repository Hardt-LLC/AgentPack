#!/usr/bin/env node
// Harmless example hook: prints a deterministic message and exits 0.
// AgentPack never executes this; the native agent may, after you trust it.
console.log("check-shell: no dangerous shell patterns detected");
process.exit(0);
