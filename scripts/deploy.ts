/**
 * Deploy script for the dynamic dispatch example.
 *
 * Deploys toka, tokb, and token_router by running `leo deploy` from
 * each project directory. Programs are skipped if already deployed.
 *
 * For devnets: uses the SDK (avoids VK mismatch with devnode).
 * For live networks: uses `leo deploy` CLI.
 *
 * Usage:
 *   DOTENV=devnet npx tsx scripts/deploy.ts
 *   DOTENV=canary npx tsx scripts/deploy.ts
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { TransactionExecutor } from "../src-ts/client/transaction-executor.js";
import { AleoClient } from "../src-ts/client/aleo-client.js";
import { config } from "../src-ts/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const LEO_BIN = process.env.LEO_BIN || "leo";

// Programs to deploy, in dependency order
const PROGRAMS = [
  { name: "toka_token.aleo", dir: "toka_token" },
  { name: "tokb_token.aleo", dir: "tokb_token" },
  { name: "token_router.aleo", dir: "token_router" },
];

// ── SDK deploy ──────────────────────────────────────────────────────

let sdkInitialized = false;

async function ensureSDKInitialized() {
  if (sdkInitialized) return;
  const { initThreadPool } = await import("@provablehq/sdk");
  await initThreadPool();
  if (config.devnet) {
    const { getOrInitConsensusVersionTestHeights } = await import("@provablehq/sdk");
    getOrInitConsensusVersionTestHeights("0,1,2,3,4,5,6,7,8,9,10,11,12,13");
  }
  sdkInitialized = true;
}

async function deployWithSDK(
  deployerKey: string,
  programSource: string,
  aleoClient: AleoClient,
): Promise<{ status: string; error?: string }> {
  await ensureSDKInitialized();

  const {
    ProgramManager, AleoKeyProvider, AleoNetworkClient, PrivateKey, Account,
  } = await import("@provablehq/sdk");

  const keyProvider = new AleoKeyProvider();
  keyProvider.useCache(true);
  const networkClient = new AleoNetworkClient(config.rpcUrl);
  const programManager = new ProgramManager(config.rpcUrl, keyProvider, undefined);
  programManager.setAccount(new Account({ privateKey: deployerKey }));

  const deployOptions = {
    program: programSource,
    priorityFee: 5,
    privateFee: false,
    privateKey: PrivateKey.from_string(deployerKey),
  };

  // Devnet: skip proof generation. Live: generate real proofs.
  const tx = config.devnet
    ? await programManager.buildDevnodeDeploymentTransaction(deployOptions)
    : await programManager.buildDeploymentTransaction(
        programSource, deployOptions.priorityFee, deployOptions.privateFee,
        undefined, undefined, deployOptions.privateKey,
      );

  const txId = tx.id();
  await networkClient.submitTransaction(tx.toString());
  console.log(`  Submitted: ${txId}`);
  const timeout = config.devnet ? 120000 : 300000;
  const result = await aleoClient.waitForTransaction(txId, timeout);
  return { status: result.status, error: result.error };
}

// ── CLI deploy (live networks) ──────────────────────────────────────

function deployWithCLI(
  deployerKey: string,
  projectDir: string,
  aleoClient: AleoClient,
  skipPrograms: string[] = [],
): Promise<{ status: string; error?: string }> {
  const flags = [
    `--network ${config.network}`,
    `--endpoint ${config.rpcUrl}`,
    `--private-key ${deployerKey}`,
    "--broadcast",
    "-y",
    ...skipPrograms.map((p) => `--skip ${p}`),
  ].join(" ");

  try {
    const output = execSync(`${LEO_BIN} deploy ${flags}`, {
      cwd: projectDir,
      timeout: 600000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const txIdMatch = output.match(/(at1[a-z0-9]{58})/);
    if (!txIdMatch) {
      return Promise.resolve({ status: "rejected", error: "No transaction ID in output" });
    }
    console.log(`  Submitted: ${txIdMatch[1]}`);
    return aleoClient.waitForTransaction(txIdMatch[1], 300000);
  } catch (error: unknown) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const combined = (err.stdout || "") + (err.stderr || "");
    const txIdMatch = combined.match(/(at1[a-z0-9]{58})/);
    if (txIdMatch) {
      console.log(`  Submitted: ${txIdMatch[1]}`);
      return aleoClient.waitForTransaction(txIdMatch[1], 300000);
    }
    const msg = err.stderr || err.stdout || (error instanceof Error ? error.message : String(error));
    return Promise.resolve({ status: "rejected", error: msg.substring(0, 300) });
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function deploy() {
  const deployerKey = config.privateKeys[0];
  if (!deployerKey) {
    console.error("No private keys configured. Set PRIVATE_KEY_0 in .env");
    process.exit(1);
  }

  const aleoClient = new AleoClient();
  const healthy = await aleoClient.healthCheck();
  if (!healthy) {
    console.error(`Cannot reach node at ${config.rpcUrl}`);
    process.exit(1);
  }

  const executor = new TransactionExecutor(aleoClient);
  console.log(`Network:  ${config.network}${config.devnet ? " (devnet)" : ""}`);
  console.log(`Endpoint: ${config.rpcUrl}`);
  console.log(`Deployer: ${executor.getAddress(deployerKey)}`);
  console.log(`Backend:  ${config.backend}${config.devnet ? " (devnode, no proofs)" : " (real proofs)"}\n`);

  const deployed: string[] = [];

  for (const prog of PROGRAMS) {
    if (await aleoClient.isProgramDeployed(prog.name)) {
      console.log(`${prog.name} already deployed`);
      deployed.push(prog.name);
      continue;
    }

    console.log(`Deploying ${prog.name}...`);
    const projectDir = resolve(ROOT, prog.dir);

    let result: { status: string; error?: string };
    if (config.backend === "sdk") {
      const source = readFileSync(resolve(projectDir, "build/main.aleo"), "utf-8");
      result = await deployWithSDK(deployerKey, source, aleoClient);
    } else {
      // Build a fresh skip list by checking what's actually on-chain.
      const skipList: string[] = [];
      for (const dep of PROGRAMS) {
        if (dep.name === prog.name) break;
        if (await aleoClient.isProgramDeployed(dep.name)) {
          skipList.push(dep.name);
        }
      }
      result = await deployWithCLI(deployerKey, projectDir, aleoClient, skipList);
    }

    console.log(`  ${prog.name}: ${result.status}`, result.error || "");
    if (result.status === "accepted") deployed.push(prog.name);
  }

  console.log("\nDone.");
}

deploy().catch(console.error);
