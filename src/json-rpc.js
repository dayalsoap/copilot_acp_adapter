import { EventEmitter } from "node:events";

const EMPTY = Buffer.alloc(0);
const HEADER_PREFIX = "content-length:";
const NEWLINE = 0x0a;

const INCOMPLETE = { type: "incomplete" };
const SKIP = { type: "skip" };

export class JsonRpcConnection extends EventEmitter {
  constructor(input, output) {
    super();
    this.input = input;
    this.output = output;
    this.buffer = EMPTY;
    this.framing = "content-length";
  }

  start() {
    // Deliberately no setEncoding: Content-Length is a byte count, so the buffer
    // has to stay bytes until a complete frame has been sliced out of it.
    this.input.on("data", (chunk) => this.receive(chunk));
    this.input.on("end", () => this.emit("end"));
  }

  receive(chunk) {
    const incoming = toBuffer(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, incoming]) : incoming;

    while (this.buffer.length > 0) {
      const frame = this.readNextFrame();

      if (frame === INCOMPLETE) {
        return;
      }
      if (frame === SKIP) {
        continue;
      }
      if (frame.type === "error") {
        this.handleProtocolError(frame.error);
        continue;
      }

      let message;
      try {
        message = JSON.parse(frame.body);
      } catch (error) {
        this.handleProtocolError(new Error(`Invalid JSON-RPC message: ${error.message}`));
        continue;
      }
      this.emit("message", message);
    }
  }

  readNextFrame() {
    if (this.hasContentLengthHeader()) {
      return this.readContentLengthFrame();
    }
    return this.readNewlineFrame();
  }

  hasContentLengthHeader() {
    return (
      this.buffer.length >= HEADER_PREFIX.length &&
      this.buffer.subarray(0, HEADER_PREFIX.length).toString("latin1").toLowerCase() ===
        HEADER_PREFIX
    );
  }

  readContentLengthFrame() {
    const separator = findHeaderEnd(this.buffer);
    if (!separator) {
      return INCOMPLETE;
    }

    this.framing = "content-length";
    const header = this.buffer.subarray(0, separator.index).toString("utf8");
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      // Drop the unusable header and resynchronise on whatever follows it.
      this.buffer = this.buffer.subarray(separator.end);
      return { type: "error", error: new Error("Invalid JSON-RPC content header") };
    }

    const contentLength = Number(lengthMatch[1]);
    const bodyStart = separator.end;
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) {
      return INCOMPLETE;
    }

    const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return { type: "frame", body };
  }

  readNewlineFrame() {
    const lineEnd = this.buffer.indexOf(NEWLINE);
    if (lineEnd === -1) {
      return INCOMPLETE;
    }

    const line = this.buffer.subarray(0, lineEnd).toString("utf8").trim();
    this.buffer = this.buffer.subarray(lineEnd + 1);
    if (!line) {
      // Blank keepalive line: consume it and keep draining what is already buffered.
      return SKIP;
    }

    this.framing = "newline";
    return { type: "frame", body: line };
  }

  handleProtocolError(error) {
    process.stderr.write(`copilot-acp-adapter: ${error.message}\n`);
    this.emit("parseError", error);
  }

  send(message) {
    const body = JSON.stringify(message);
    if (this.framing === "newline") {
      this.output.write(`${body}\n`);
      return;
    }
    this.output.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
}

function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
}

function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, end: crlf + 4 };
  }
  if (lf !== -1) {
    return { index: lf, end: lf + 2 };
  }
  return null;
}
