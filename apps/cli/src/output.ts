import {
  redactSecrets,
  type CapabilityReport,
  type Diagnostic,
  type TargetDetection,
} from "@agentpack/schema";
import { describeOperation, type PlannedOperation } from "@agentpack/filesystem";
import type { SyncPlan, TargetPlan } from "@agentpack/core";

/** Write a line to stdout, redacting anything that looks like a secret. */
export function out(text = ""): void {
  process.stdout.write(`${redactSecrets(text)}\n`);
}

/** Write a line to stderr, redacting anything that looks like a secret. */
export function err(text = ""): void {
  process.stderr.write(`${redactSecrets(text)}\n`);
}

/** Print the stable machine-readable envelope as the only stdout output. */
export function printEnvelope(command: string, ok: boolean, data: unknown): void {
  out(JSON.stringify({ version: 1, command, ok, data }, null, 2));
}

const SEVERITY_LABEL: Record<Diagnostic["severity"], string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Info",
};

/** Print diagnostics grouped by severity to stderr (human mode only). */
export function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const severity of ["error", "warning", "info"] as const) {
    const group = diagnostics.filter((d) => d.severity === severity);
    if (group.length === 0) continue;
    err(`${SEVERITY_LABEL[severity]} (${group.length}):`);
    for (const diagnostic of group) {
      err(`  - ${diagnostic.message}${diagnostic.source ? ` [${diagnostic.source}]` : ""}`);
    }
  }
}

/** Pad to `width`, always leaving at least one trailing space. */
function column(text: string, width: number): string {
  return text.padEnd(Math.max(width, text.length + 1));
}

/** Print capability findings as a fixed-width table; skipped when empty. */
export function printCapabilityTable(reports: CapabilityReport[]): void {
  const findings = reports.flatMap((report) => report.findings);
  if (findings.length === 0) return;
  out(column("TARGET", 8) + column("COMPONENT", 24) + column("SUPPORT", 12) + "DETAILS");
  for (const finding of findings) {
    const component = `${finding.componentType}:${finding.componentId}`;
    out(
      column(finding.target, 8) +
        column(component, 24) +
        column(finding.support, 12) +
        (finding.message ?? "-"),
    );
  }
}

/** Print detected agents: installed/version plus any detection warnings. */
export function printDetection(
  detected: Partial<Record<string, TargetDetection | undefined>>,
): void {
  out("Detected agents:");
  for (const [target, detection] of Object.entries(detected)) {
    if (!detection) {
      out(`  ${target}: not detected`);
      continue;
    }
    out(
      `  ${target}: ${detection.installed ? `installed${detection.version ? ` (${detection.version})` : ""}` : "not detected"}`,
    );
    for (const warning of detection.warnings) {
      err(`  warning [${target}]: ${warning}`);
    }
  }
}

function printGroup(title: string, operations: PlannedOperation[]): void {
  if (operations.length === 0) return;
  out(`  ${title}:`);
  for (const planned of operations) out(`    - ${planned.detail}`);
}

/** Print per-target planned operations grouped by action, plus counts. */
export function printTargetPlans(plan: SyncPlan): void {
  for (const targetPlan of plan.targets) {
    printTargetPlan(targetPlan);
  }
}

function printTargetPlan(targetPlan: TargetPlan): void {
  const creates = targetPlan.operations.filter((p) => p.action === "create");
  const updates = targetPlan.operations.filter((p) => p.action === "update");
  const noops = targetPlan.operations.filter((p) => p.action === "noop");
  const removals = targetPlan.removals.filter((p) => p.action !== "noop");
  out(
    `Target ${targetPlan.target}: ${creates.length} to create, ${updates.length} to update, ` +
      `${removals.length} to remove (stale owned), ${noops.length} unchanged`,
  );
  printGroup("CREATE", creates);
  printGroup("UPDATE", updates);
  printGroup("REMOVE (stale owned)", removals);
  printGroup("NO CHANGE", noops);

  const configOps = targetPlan.operations.filter(
    (p) =>
      p.operation.type === "mergeJson" ||
      p.operation.type === "mergeToml" ||
      p.operation.type === "managedMarkdownSection",
  );
  if (configOps.length > 0) {
    out("  Config keys to merge:");
    for (const planned of configOps) out(`    - ${describeOperation(planned.operation)}`);
  }
  for (const warning of targetPlan.warnings) {
    err(`  warning [${targetPlan.target}]: ${warning}`);
  }
}

/** "Install strategy: symlink (auto)" — or copy with the reason. */
export function formatInstallStrategy(plan: SyncPlan): string {
  const mode = plan.selection.installMode;
  if (plan.installStrategy === "symlink") {
    return `Install strategy: symlink (${mode === "auto" ? "auto" : `mode ${mode}`})`;
  }
  const reason =
    mode === "copy"
      ? "mode copy"
      : mode === "auto"
        ? "symlinks unreliable on this platform"
        : `mode ${mode}`;
  return `Install strategy: copy (${reason})`;
}
