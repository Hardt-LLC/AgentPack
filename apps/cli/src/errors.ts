/** Fatal CLI error carrying a process exit code. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/**
 * Silent control-flow signal: the action already printed everything it needs
 * to; main() just exits with this code.
 */
export class ExitSignal {
  readonly code: number;

  constructor(code: number) {
    this.code = code;
  }
}
