import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Build the CLI exactly once per test run. Individual e2e files must not
 * build in beforeAll: tsup cleans dist/, and parallel test files would race
 * each other and execute a half-written bundle.
 */
export default function globalSetup(): void {
  const repoRoot = path.resolve(__dirname, "../../..");
  execSync("pnpm --filter agentpack build", { cwd: repoRoot, stdio: "inherit" });
}
