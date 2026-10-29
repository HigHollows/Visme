import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { createApp } from "@assistant/core";

/** Ouvre une URL https dans le navigateur par défaut (sans passer par un shell). */
function openUrl(url: string) {
  if (new URL(url).protocol !== "https:") throw new Error("Seules les URL https sont ouvertes");
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  execFile(cmd, args as string[], (err) => err && console.error("[sidecar] ouverture du navigateur :", err.message));
}

// stdout est réservé au protocole RPC ; les logs vont sur stderr.
const rpc = createApp({
  openUrl,
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
