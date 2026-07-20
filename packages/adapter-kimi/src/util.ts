import type { TargetId } from "@agentpack/schema";

/** A component without an explicit target list applies to every target. */
export function targetsKimi(targets: TargetId[] | undefined): boolean {
  return !targets || targets.includes("kimi");
}
