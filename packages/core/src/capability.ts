import type {
  CapabilityFinding,
  CapabilityReport,
  Diagnostic,
  Strictness,
} from "@agentpack/schema";

/** Rank support levels so "worse than X" comparisons are readable. */
const SUPPORT_RANK: Record<CapabilityFinding["support"], number> = {
  native: 0,
  transpiled: 1,
  degraded: 2,
  unsupported: 3,
};

/**
 * Convert capability findings into diagnostics under a strictness mode.
 *
 * - permissive: non-native findings are warnings; nothing fails.
 * - strict:     degraded and unsupported findings are errors.
 * - portable:   a component must be native or transpiled; degraded and
 *               unsupported findings are errors (the component is not
 *               usable across every selected target).
 */
export function strictnessDiagnostics(
  reports: CapabilityReport[],
  strictness: Strictness,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const report of reports) {
    for (const finding of report.findings) {
      if (finding.support === "native") continue;
      const label = `${finding.target} ${finding.componentType}:${finding.componentId}`;
      const detail = finding.remediation
        ? `${finding.message ?? finding.support} — ${finding.remediation}`
        : (finding.message ?? finding.support);
      if (strictness === "permissive") {
        diagnostics.push({
          severity: "warning",
          message: `${label}: ${finding.support} (${detail})`,
        });
        continue;
      }
      const rank = SUPPORT_RANK[finding.support];
      if (strictness === "strict" && rank >= SUPPORT_RANK.degraded) {
        diagnostics.push({
          severity: "error",
          message: `${label}: ${finding.support} (${detail})`,
        });
      } else if (strictness === "portable" && rank >= SUPPORT_RANK.degraded) {
        diagnostics.push({
          severity: "error",
          message: `${label}: ${finding.support} — not portable across all selected targets (${detail})`,
        });
      } else {
        diagnostics.push({
          severity: "warning",
          message: `${label}: ${finding.support} (${detail})`,
        });
      }
    }
  }
  return diagnostics;
}

/** Merge several reports into one. */
export function mergeReports(reports: CapabilityReport[]): CapabilityReport {
  return { findings: reports.flatMap((r) => r.findings) };
}
