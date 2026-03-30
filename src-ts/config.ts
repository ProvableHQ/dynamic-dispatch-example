import * as dotenv from "dotenv";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

/**
 * Load environment from a named env file.
 *
 * Resolution order:
 *   1. DOTENV env var (e.g. DOTENV=canary → .env.canary)
 *   2. --env CLI arg (e.g. npm test -- --env canary)
 *   3. .env (default)
 *
 * This lets you keep separate configs per network:
 *   .env.devnet   — local devnode
 *   .env.canary   — canary network
 *   .env.mainnet  — mainnet
 */
function loadEnv(): void {
  // Check DOTENV env var first
  let envName = process.env.DOTENV;

  // Check --env CLI arg
  if (!envName) {
    const envArgIdx = process.argv.indexOf("--env");
    if (envArgIdx !== -1 && process.argv[envArgIdx + 1]) {
      envName = process.argv[envArgIdx + 1];
    }
  }

  if (envName) {
    const envPath = resolve(projectRoot, `.env.${envName}`);
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
    console.warn(`Warning: .env.${envName} not found, falling back to .env`);
  }

  dotenv.config({ path: resolve(projectRoot, ".env") });
}

loadEnv();

/**
 * Load all PRIVATE_KEY_N environment variables into an ordered array.
 * Scans PRIVATE_KEY_0, PRIVATE_KEY_1, ... until a gap is found.
 */
function loadPrivateKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; ; i++) {
    const key = process.env[`PRIVATE_KEY_${i}`];
    if (!key) break;
    keys.push(key);
  }
  return keys;
}

export interface Config {
  /** Network name: "testnet", "canary", or "mainnet" */
  network: string;
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Whether this is a local devnet */
  devnet: boolean;
  /** Execution backend: "sdk" or "cli" */
  backend: "sdk" | "cli";
  /** The router program ID */
  programId: string;
  /** Ordered list of private keys loaded from PRIVATE_KEY_0, PRIVATE_KEY_1, ... */
  privateKeys: string[];
}

// Devnode default key — only used when no keys are configured
const DEVNODE_KEY_0 = "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";
const DEVNODE_KEY_1 = "APrivateKey1zkp2RWGDcde3efb89rjhME1VYA8QMxcxep5DShNBR6n8Yjh";

function buildConfig(): Config {
  const privateKeys = loadPrivateKeys();

  // Fall back to devnode keys if no keys configured
  if (privateKeys.length === 0) {
    console.warn("Warning: No PRIVATE_KEY_0 configured — using default devnode keys.");
    privateKeys.push(DEVNODE_KEY_0, DEVNODE_KEY_1);
  }

  const devnet = process.env.DEVNET === "true";
  const backend = (process.env.BACKEND as "sdk" | "cli") || (devnet ? "sdk" : "cli");

  return {
    network: process.env.NETWORK || "testnet",
    rpcUrl: process.env.ENDPOINT || "http://localhost:3030",
    devnet,
    backend,
    programId: "token_router.aleo",
    privateKeys,
  };
}

export const config = buildConfig();
