import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import type { Diagnostic } from "@agentpack/schema";
import type { AdapterRegistry } from "./registry.js";
import { loadWorkspace } from "./load-workspace.js";
import { syncWorkspace, type SyncOptions, type SyncResult } from "./sync.js";

export interface WatchEvent {
  type: "started" | "changed" | "synced" | "refused" | "conflict" | "error";
  message: string;
  result?: SyncResult;
  diagnostics?: Diagnostic[];
}

export interface WatchOptions extends SyncOptions {
  /** Debounce window for filesystem events. Default 400ms. */
  debounceMs?: number;
  onEvent: (event: WatchEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

const IGNORED_SEGMENTS = new Set([".git", ".agentpack", "node_modules", "dist"]);

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

  await new Promise<void>((resolve) => {
    if (opts.signal?.aborted) return resolve();
    opts.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

  if (timer) clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
}
