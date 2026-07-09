import { CopilotAcpAdapter } from "./adapter.js";
import { loadConfig } from "./config.js";
import { CopilotRunner } from "./copilot-runner.js";
import { JsonRpcConnection } from "./json-rpc.js";

export async function main({ input = process.stdin, output = process.stdout } = {}) {
  const config = loadConfig();
  let connection;
  const adapter = new CopilotAcpAdapter({
    config,
    runner: new CopilotRunner(config),
    notify(method, params) {
      connection?.send({ jsonrpc: "2.0", method, params });
    },
  });
  connection = new JsonRpcConnection(input, output);

  connection.on("message", async (message) => {
    if (!isRequest(message)) {
      return;
    }

    try {
      const result = await adapter.handle(message.method, message.params || {});
      if (message.id !== undefined) {
        connection.send({ jsonrpc: "2.0", id: message.id, result });
      }
    } catch (error) {
      if (message.id !== undefined) {
        connection.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: error.code || -32603,
            message: error.message || "Internal error",
          },
        });
      }
    }
  });

  connection.start();
}

function isRequest(message) {
  return message && message.jsonrpc === "2.0" && typeof message.method === "string";
}
