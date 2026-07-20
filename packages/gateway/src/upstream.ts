import { createInterface } from "node:readline";

export interface MessageHandler {
  handleMessage(msg: unknown): Promise<unknown | undefined>;
}

export interface StdioLoopOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (msg: string) => void;
}

/**
 * Upstream NDJSON loop: one JSON-RPC message per line in, one per line out.
 * Malformed lines are logged and skipped; notifications produce no output.
 */
export async function runStdioLoop(
  handler: MessageHandler,
  opts?: StdioLoopOptions,
): Promise<void> {
  const input = opts?.input ?? process.stdin;
  const output = opts?.output ?? process.stdout;
  const log = opts?.log ?? ((msg: string) => process.stderr.write(msg + "\n"));

  const rl = createInterface({ input, terminal: false });
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        log(`gateway: ignoring malformed line: ${trimmed.slice(0, 200)}`);
        return;
      }
      void handler
        .handleMessage(msg)
        .then((response) => {
          if (response !== undefined) {
            output.write(JSON.stringify(response) + "\n");
          }
        })
        .catch((err: unknown) => {
          log(`gateway: handler error: ${(err as Error).message}`);
        });
    });
    rl.on("close", () => resolve());
  });
}
