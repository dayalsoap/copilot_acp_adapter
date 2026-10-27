#!/usr/bin/env node
// Read-only probe of native `copilot --acp`: records initialize, session/new,
// session/list and the advertised slash commands, then closes the session.
// No prompts are sent, so no model usage. Output: scripts/native-acp-probe.json
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const bin = process.env.COPILOT_COMMAND || "copilot";
const log = [];
const out = { version: "", order: [], initialize: null, sessionNew: null, sessionList: null, commands: [], otherUpdates: [] };
try { out.version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(); } catch (e) { out.version = `error: ${e.message}`; }

const child = spawn(bin, ["--acp", "--stdio", "--no-color"], { cwd: repo, env: { ...process.env, COPILOT_AUTO_UPDATE: "false" }, stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; let nextId = 1; const pending = new Map();
const send = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && !m.method && pending.has(m.id)) { out.order.push(`response#${m.id}`); pending.get(m.id)(m); pending.delete(m.id); continue; }
    if (m.method === "session/update") {
      const u = m.params?.update || {}; out.order.push(`update:${u.sessionUpdate}`);
      if (u.sessionUpdate === "available_commands_update") out.commands = u.availableCommands || [];
      else out.otherUpdates.push(u);
    } else if (m.id !== undefined && m.method) {
      out.order.push(`client-request:${m.method}`);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } }) + "\n");
    }
  }
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = setTimeout(() => { finish("timeout"); }, 60000);
function finish(reason) {
  out.finishedBy = reason;
  out.commandNames = out.commands.map((c) => `/${c.name}`).sort();
  const file = join(here, "native-acp-probe.json");
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`version: ${out.version}\nwrote ${file}\ncommands (${out.commandNames.length}): ${out.commandNames.join(" ")}`);
  child.kill(); clearTimeout(timeout); process.exit(0);
}
out.initialize = (await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } })).result ?? "error";
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
const sn = await send("session/new", { cwd: repo, mcpServers: [] });
out.sessionNew = sn.result ?? sn.error;
await wait(4000);
const sl = await send("session/list", { cwd: repo });
out.sessionList = sl.error ? sl.error : { count: sl.result?.sessions?.length, titlesWithNewlines: (sl.result?.sessions || []).filter((s) => /[\r\n]/.test(s.title || "")).length, sample: sl.result?.sessions?.slice(0, 3) };
if (sn.result?.sessionId) { const c = await send("session/close", { sessionId: sn.result.sessionId }); out.sessionClose = c.result ?? c.error; }
finish("done");
