/**
 * Preflight checks — validates the environment before deploy or test.
 *
 * Checks:
 *   1. Leo binary exists and is executable
 *   2. SDK installed (node_modules)
 *   3. Programs built (build artifacts exist)
 *   4. Configured endpoint is reachable
 *   5. For live networks: reports which programs are deployed
 *
 * Usage:
 *   DOTENV=testnet npx tsx scripts/preflight.ts
 */
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "../src-ts/config.js";
import { AleoClient } from "../src-ts/client/aleo-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const LEO_BIN = process.env.LEO_BIN || "leo";

const PROGRAMS = [
  { name: "toka_token.aleo", build: "toka_token/build/main.aleo" },
  { name: "tokb_token.aleo", build: "tokb_token/build/main.aleo" },
  { name: "token_router.aleo", build: "token_router/build/main.aleo" },
];

let failures = 0;

function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); failures++; }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }

// ── 1. Leo binary ──────────────────────────────────────────────────

console.log("\n1. Leo compiler");
try {
  const version = execSync(`${LEO_BIN} --version`, {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  pass(`${LEO_BIN} → ${version}`);
} catch {
  fail(`Leo binary not found at: ${LEO_BIN}`);
  console.log(`    Set LEO_BIN env var or install Leo.`);
  console.log(`    See: https://github.com/ProvableHQ/leo`);
}

// ── 2. SDK ─────────────────────────────────────────────────────────

console.log("\n2. SDK");
const sdkDir = resolve(ROOT, "node_modules/@provablehq/sdk");
const wasmDir = resolve(ROOT, "node_modules/@provablehq/wasm/dist", config.network);

if (existsSync(sdkDir)) {
  pass("@provablehq/sdk installed");
} else {
  fail("@provablehq/sdk not installed");
  console.log(`    Run: npm install`);
}

if (existsSync(wasmDir)) {
  pass(`WASM available for ${config.network}`);
} else {
  fail(`WASM missing for ${config.network}`);
  console.log(`    Run: npm install`);
}

// ── 3. Build artifacts ─────────────────────────────────────────────

console.log("\n3. Build artifacts");
for (const prog of PROGRAMS) {
  const buildPath = resolve(ROOT, prog.build);
  if (existsSync(buildPath)) {
    pass(`${prog.name} built`);
  } else {
    fail(`${prog.name} not built`);
    console.log(`    Run: npm run build:leo`);
  }
}

const importsDir = resolve(ROOT, "token_router/build/imports");
const tokaImport = resolve(importsDir, "toka_token.aleo");
const tokbImport = resolve(importsDir, "tokb_token.aleo");
if (existsSync(tokaImport) && existsSync(tokbImport)) {
  pass("token_router imports copied");
} else {
  fail("token_router/build/imports/ missing dependency files");
  console.log(`    Run: npm run build:leo`);
}

// ── 4. Network endpoint ────────────────────────────────────────────

console.log("\n4. Network");
console.log(`   Config: ${config.network}${config.devnet ? " (devnet)" : ""} @ ${config.rpcUrl}`);
console.log(`   Backend: ${config.backend}`);

const aleoClient = new AleoClient();
const healthy = await aleoClient.healthCheck();
if (healthy) {
  pass("Endpoint reachable");
} else {
  fail(`Cannot reach ${config.rpcUrl}`);
  if (config.devnet) {
    console.log(`    Start devnode: leo devnode start --network testnet --consensus-heights "0,1,2,3,4,5,6,7,8,9,10,11,12,13"`);
  }
}

// ── 5. Program deployment status ───────────────────────────────────

if (healthy) {
  console.log("\n5. Deployment status");
  for (const prog of PROGRAMS) {
    const deployed = await aleoClient.isProgramDeployed(prog.name);
    if (deployed) {
      pass(`${prog.name} deployed`);
    } else {
      warn(`${prog.name} not deployed`);
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────

console.log("");
if (failures > 0) {
  console.log(`Preflight failed: ${failures} issue(s) found.`);
  process.exit(1);
} else {
  console.log("Preflight passed.");
}
