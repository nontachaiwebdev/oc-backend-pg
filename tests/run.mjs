import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobServiceClient } from "@azure/storage-blob";
import dotenv from "dotenv";

// Runs the API tests against a temporary database and blob container, then removes both.
// No real env values reach the server except the local database address, so no AI calls are possible.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE = "oc_test_security";
const CONTAINER = "oc-test-security";
const PORT = "4099";
const STORAGE = "UseDevelopmentStorage=true";

const base = dotenv.parse(readFileSync(resolve(ROOT, ".env"))).DATABASE_URL;
if (!base) throw new Error("DATABASE_URL is required in .env");
const url = new URL(base);
if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Tests only run against local Docker Postgres");
url.pathname = `/${DATABASE}`;

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOTENV_CONFIG_PATH: "/dev/null",
  DATABASE_URL: url.href,
  NODE_ENV: "test",
  PORT,
  SERVICE_NAME: "oc-test",
  KNOWLEDGE_BASE_NAME: "test",
  JWT_SECRET: "temporary-test-secret-0123456789abcdef",
  CORS_ORIGINS: "http://localhost:5173",
  AZURE_STORAGE_CONNECTION_STRING: STORAGE,
  AZURE_STORAGE_CONTAINER: CONTAINER,
};

const postgres = (command) =>
  spawnSync("docker", ["compose", "exec", "-T", "postgres", command, "-U", "postgres", ...(command === "dropdb" ? ["--if-exists"] : []), DATABASE], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  }).status;
const node = (...args) => spawnSync(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, env, stdio: "inherit" }).status;

postgres("dropdb");
if (postgres("createdb") !== 0) throw new Error("Could not create the test database. Is `npm run db:up` running?");

let server;
let status = 1;
try {
  if (node("src/db/migrate.ts") !== 0) throw new Error("Migrations failed");
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
  const security = node("tests/security.mjs");
  const smoke = node("src/smoke.ts", `http://127.0.0.1:${PORT}`);
  status = security === 0 && smoke === 0 ? 0 : 1;
} finally {
  if (server) {
    const closed = new Promise((done) => server.once("exit", done));
    server.kill("SIGTERM");
    await closed;
  }
  await BlobServiceClient.fromConnectionString(STORAGE).getContainerClient(CONTAINER).deleteIfExists().catch(() => undefined);
  postgres("dropdb");
}
process.exit(status);
