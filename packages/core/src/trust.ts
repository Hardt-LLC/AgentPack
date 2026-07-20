import path from "node:path";
import type { CanonicalPack } from "@agentpack/schema";
import { hashFile, sha256 } from "@agentpack/filesystem";

/** What executable power a pack asks for. */
export interface TrustRequirement {
  pack: string;
  localMcpCommands: number;
  remoteMcpEndpoints: number;
  hooks: number;
  scriptFiles: number;
  /** Hash over everything executable; changing it invalidates trust. */
  contentHash: string;
}

export interface TrustRefusal {
  requirement: TrustRequirement;
  reason: string;
}

/** Compute the trust surface of a pack (reads script file contents for hashing). */
export async function trustRequirement(pack: CanonicalPack): Promise<TrustRequirement> {
  const mcpServers = Object.values(pack.mcpServers).filter((s) => s.enabled !== false);
  const localMcpCommands = mcpServers.filter((s) => s.transport === "stdio").length;
  const remoteMcpEndpoints = mcpServers.filter((s) => s.transport !== "stdio").length;
  const hooks = pack.hooks.length;
  const scriptPaths = pack.skills.flatMap((s) =>
    s.files
      .filter((f) => f.startsWith("scripts/") || /\.(mjs|cjs|js|sh|py|rb|ts)$/.test(f))
      .map((f) => ({ skill: s, rel: f })),
  );
  const scriptFiles = scriptPaths.length;

  // Hash executable file CONTENTS (not just paths) so editing a script
  // invalidates previously granted trust.
  const scriptHashes: string[] = [];
  for (const { skill, rel } of scriptPaths) {
    scriptHashes.push(`${skill.name}/${rel}:${await hashFile(path.join(skill.rootDir, rel))}`);
  }

  const hashMaterial = JSON.stringify({
    mcp: Object.fromEntries(
      Object.entries(pack.mcpServers).map(([name, s]) => [
        name,
        { transport: s.transport, command: s.command, args: s.args, url: s.url },
      ]),
    ),
    hooks: pack.hooks.map((h) => ({ id: h.id, event: h.event, command: h.command })),
    scripts: scriptHashes,
  });

  return {
    pack: pack.metadata.name,
    localMcpCommands,
    remoteMcpEndpoints,
    hooks,
    scriptFiles,
    contentHash: sha256(hashMaterial),
  };
}

/** A pack needs explicit trust only if it has executable components. */
export function requiresTrust(req: TrustRequirement): boolean {
  return req.localMcpCommands + req.hooks + req.scriptFiles + req.remoteMcpEndpoints > 0;
}

/** Render the human trust summary (shown before sync). */
export function formatTrustSummary(req: TrustRequirement): string {
  const lines = [`Pack ${req.pack} requests:`];
  if (req.localMcpCommands > 0) lines.push(`- ${req.localMcpCommands} local MCP command(s)`);
  if (req.scriptFiles > 0) lines.push(`- ${req.scriptFiles} executable script(s)`);
  if (req.hooks > 0) lines.push(`- ${req.hooks} hook(s)`);
  if (req.remoteMcpEndpoints > 0) {
    lines.push(`- network access through ${req.remoteMcpEndpoints} remote MCP endpoint(s)`);
  }
  return lines.join("\n");
}

/**
 * Decide which packs block synchronization for trust reasons. A pack is
 * allowed when it requires no trust, was granted trust for the same content
 * hash in a previous run, or is explicitly trusted via --trust.
 */
export async function evaluateTrust(
  packs: CanonicalPack[],
  recordedTrust: Record<string, { contentHash: string; grantedAt: string }> | undefined,
  explicitlyTrusted: string[],
): Promise<{ refusals: TrustRefusal[]; newlyTrusted: TrustRequirement[] }> {
  const refusals: TrustRefusal[] = [];
  const newlyTrusted: TrustRequirement[] = [];
  for (const pack of packs) {
    const req = await trustRequirement(pack);
    if (!requiresTrust(req)) continue;
    const recorded = recordedTrust?.[req.pack];
    if (recorded && recorded.contentHash === req.contentHash) continue;
    if (explicitlyTrusted.includes(req.pack)) {
      newlyTrusted.push(req);
      continue;
    }
    refusals.push({
      requirement: req,
      reason: recorded
        ? "executable components changed since trust was granted"
        : "pack contains executable components and is not trusted",
    });
  }
  return { refusals, newlyTrusted };
}
