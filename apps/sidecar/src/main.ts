import { createInterface } from "node:readline";
import { createApp } from "@assistant/core";

// stdout est réservé au protocole RPC ; les logs vont sur stderr.
const rpc = createApp({
  notify: (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
});
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const out = await rpc.handleLine(line);
  if (out) process.stdout.write(out + "\n");
});
rl.on("close", () => process.exit(0));
console.error("[sidecar] prêt");
