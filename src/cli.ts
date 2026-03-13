import { startCli } from "./lib/cli.js";

const controller = new AbortController();

process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

startCli(process.argv, { signal: controller.signal }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
