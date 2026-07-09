import { EventEmitter } from "node:events";

export class JsonRpcConnection extends EventEmitter {
  constructor(input, output) {
    super();
    this.input = input;
    this.output = output;
    this.buffer = "";
  }

  start() {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk) => this.receive(chunk));
    this.input.on("end", () => this.emit("end"));
  }

  receive(chunk) {
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      const message = this.readNextMessage();
      if (!message) {
        return;
      }
      this.emit("message", message);
    }
  }

  readNextMessage() {
    if (this.buffer.startsWith("Content-Length:")) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return null;
      }

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = "";
        throw new Error("Invalid JSON-RPC content header");
      }

      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return null;
      }

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);
      return JSON.parse(body);
    }

    const lineEnd = this.buffer.indexOf("\n");
    if (lineEnd === -1) {
      return null;
    }

    const line = this.buffer.slice(0, lineEnd).trim();
    this.buffer = this.buffer.slice(lineEnd + 1);
    if (!line) {
      return null;
    }
    return JSON.parse(line);
  }

  send(message) {
    const body = JSON.stringify(message);
    this.output.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
}
