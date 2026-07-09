#!/usr/bin/env node
import { main } from "../src/server.js";

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
