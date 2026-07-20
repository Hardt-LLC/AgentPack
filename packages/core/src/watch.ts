import path from "node:path";
import { promises as fs } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import type { Diagnostic, TargetId } from "@agentpack/schema";
import type { AdapterRegistry } from "./registry.js";
import { collectFromTarget } from "./collect.js";
import { loadWorkspace } from "./load-workspace.js";
import { syncWorkspace, type SyncOptions, type SyncResult } from "./sync.js";

export interface WatchEvent {
  type: "started" | "changed" | "synced" | "refused" | "conflict" | "error" | "collected";
  message: string;
  result?: SyncResult;
  diagnostics?: Diagnostic[];
}

export interface WatchOptions extends SyncOptions {
  /** Debounce window for filesystem events. Default 400ms. */
  debounceMs?: number;
  /**
   * Also watch each target's native sources (adapter.nativeSources) and
   * collect newly installed servers/skills into packs/inbox-<target>.
   * Collected entries are never synced out automatically.
   */
  collect?: boolean;
  onEvent: (event: WatchEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

const IGNORED_SEGMENTS = new Set([".git", ".agentpack", "node_modules", "dist"]);

/** Debounce window for native-source change events in collect mode. */
const COLLECT_DEBOUNCE_MS = 2000;

function isIgnored(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg));
}

/**
 * Watch all pack directories and re-synchronize on change. Runs until the
 * AbortSignal fires. Trust decisions recorded in state.json are reused, so
 * only packs whose executable components changed will refuse (and are
 * reported, watching continues).
 */
export async function watchWorkspace(
  workspaceRoot: string,
  registry: AdapterRegistry,
  opts: WatchOptions,
): Promise<void> {
  const debounceMs = opts.debounceMs ?? 400;
  const watchers: FSWatcher[] = [];
  const collectTimers = new Map<TargetId, NodeJS.Timeout>();
  let collectQuietUntil = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;

  async function cycle(trigger: string): Promise<void> {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const workspace = await loadWorkspace(workspaceRoot);
      const result = await syncWorkspace(workspace, registry, opts);
      if (result.trustRefusals.length > 0) {
        await opts.onEvent({
          type: "refused",
          message: `trust refused for: ${result.trustRefusals.map((r) => r.requirement.pack).join(", ")}`,
          result,
          diagnostics: result.diagnostics,
        });
      } else if (result.conflicts.length > 0) {
        await opts.onEvent({
          type: "conflict",
          message: `${result.conflicts.length} conflict(s): ${result.conflicts.map((c) => c.path).join(", ")}`,
          result,
          diagnostics: result.diagnostics,
        });
      } else {
        const changes = result.plan.targets.flatMap((t) =>
          t.operations.filter((o) => o.action !== "noop"),
        ).length;
        await opts.onEvent({
          type: "synced",
          message: `${trigger}: ${changes} change(s) applied`,
          result,
          diagnostics: result.diagnostics,
        });
      }
    } catch (error) {
      await opts.onEvent({ type: "error", message: (error as Error).message });
    } finally {
      running = false;
      if (queued) {
        queued = false;
        await cycle("queued change");
      }
    }
  }

  const workspace = await loadWorkspace(workspaceRoot);
  const watchRoots = workspace.packs.map((p) => p.rootDir);
  watchRoots.push(workspaceRoot); // agentpack.yaml itself (events filtered below)

  for (const root of new Set(watchRoots)) {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = path.relative(workspaceRoot, path.join(root, filename));
      if (isIgnored(rel)) return;
      if (opts.collect) {
        // Collect writes inbox packs and agentpack.yaml itself; those writes
        // must not trigger a sync cycle (inbox packs are never profiled).
        if (/^packs[\\/]inbox-[^\\/]+[\\/]/.test(rel)) return;
        if (Date.now() < collectQuietUntil) return;
      }
      // Only react to canonical inputs.
      if (!/\.(ya?ml|md|mjs|cjs|js|ts|json|sh|py|toml)$/.test(filename)) return;
      void opts.onEvent({ type: "changed", message: rel });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void cycle(rel), debounceMs);
    });
    watchers.push(watcher);
  }

  await opts.onEvent({
    type: "started",
    message: `watching ${watchRoots.length} directorie(s); initial sync`,
  });
  await cycle("initial sync");

  /* ------------------- native change collection mode ------------------- */

  async function runCollect(target: TargetId): Promise<void> {
    // Suppress sync triggers from collect's own writes (inbox pack, and the
    // agentpack.yaml reference it appends).
    collectQuietUntil = Date.now() + 15000;
    try {
      const workspace = await loadWorkspace(workspaceRoot);
      const result = await collectFromTarget(workspace, registry, target, {
        scope: "user",
        env: opts.env,
        homeDir: opts.homeDir,
      });
      collectQuietUntil = Date.now() + 2 * debounceMs + 500;
      const error = result.diagnostics.find((d) => d.severity === "error");
      if (error) {
        await opts.onEvent({
          type: "error",
          message: `collect from ${target} failed: ${error.message}`,
          diagnostics: result.diagnostics,
        });
        return;
      }
      if (result.changed) {
        const count = result.newSkills.length + result.newServers.length;
        await opts.onEvent({
          type: "collected",
          message: `collected ${count} new item(s) from ${target} → packs/inbox-${target} (review before promoting)`,
        });
      } else {
        await opts.onEvent({ type: "changed", message: `collect from ${target}: no new items` });
      }
    } catch (error) {
      await opts.onEvent({ type: "error", message: (error as Error).message });
    }
  }

  if (opts.collect) {
    const env = opts.env ?? process.env;
    const homeDir = opts.homeDir ?? process.env.HOME ?? "";
    for (const id of registry.ids()) {
      const adapter = registry.get(id);
      if (!adapter.import || !adapter.nativeSources) continue;
      let sources: string[];
      try {
        sources = await adapter.nativeSources({
          scope: "user",
          projectRoot: workspaceRoot,
          homeDir,
          env,
          options: opts.adapterOptions ?? {},
        });
      } catch {
        continue;
      }
      for (const source of sources) {
        const stat = await fs.stat(source).catch(() => undefined);
        const isDir = stat?.isDirectory() === true;
        const watchDir = isDir ? source : path.dirname(source);
        const basename = isDir ? undefined : path.basename(source);
        try {
          const watcher = watch(watchDir, { recursive: isDir }, (_event, filename) => {
            if (!isDir && filename !== basename) return;
            const existing = collectTimers.get(id);
            if (existing) clearTimeout(existing);
            collectTimers.set(
              id,
              setTimeout(() => {
                collectTimers.delete(id);
                void runCollect(id);
              }, COLLECT_DEBOUNCE_MS),
            );
          });
          watchers.push(watcher);
        } catch {
          // Parent dir missing — nothing to watch yet for this source.
        }
      }
    }
  }

  await new Promise<void>((resolve) => {
    if (opts.signal?.aborted) return resolve();
    opts.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

  if (timer) clearTimeout(timer);
  for (const collectTimer of collectTimers.values()) clearTimeout(collectTimer);
  for (const watcher of watchers) watcher.close();
}
