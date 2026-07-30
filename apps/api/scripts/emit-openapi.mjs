/**
 * Emits docs/openapi.json by booting the Nest application, building the
 * document and exiting without ever listening on a port.
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "..");
const out = resolve(apiDir, "../../docs/openapi.json");

execSync("node dist/main.js", {
  cwd: apiDir,
  stdio: "inherit",
  env: {
    ...process.env,
    OPENAPI_OUT: out,
    OPENAPI_EXIT: "1",
    // A distinct port avoids clashing with a running dev server even though
    // the process exits before listening.
    API_PORT: "4099",
  },
});
