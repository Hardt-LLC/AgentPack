#!/usr/bin/env node
// Fake downstream MCP server for gateway tests: NDJSON over stdio.
import readline from "node:readline";

const tools = [
  { name: "echo", description: "Echo back the call arguments as text", inputSchema: { type: "object" } },
  { name: "fail", description: "Always returns a JSON-RPC error", inputSchema: { type: "object" } },
  { name: "env", description: "Return the value of FAKE_SERVER_ENV", inputSchema: { type: "object" } },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg === null || typeof msg !== "object" || !("id" in msg)) return; // notification
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  const fail = (code, message) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } }) + "\n");

  switch (msg.method) {
    case "initialize":
      reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-server", version: "0.0.1" },
      });
      break;
    case "ping":
      reply({});
      break;
    case "tools/list":
      reply({ tools });
      break;
    case "tools/call": {
      const params = msg.params ?? {};
      const args = params.arguments ?? {};
      if (params.name === "echo") {
        reply({ content: [{ type: "text", text: JSON.stringify(args) }] });
      } else if (params.name === "env") {
        reply({ content: [{ type: "text", text: process.env.FAKE_SERVER_ENV ?? "" }] });
      } else if (params.name === "fail") {
        fail(-32000, typeof args.message === "string" ? args.message : "intentional failure");
      } else {
        fail(-32602, `unknown tool "${String(params.name)}"`);
      }
      break;
    }
    default:
      fail(-32601, "Method not found");
  }
});
