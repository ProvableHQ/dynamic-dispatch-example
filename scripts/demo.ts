/**
 * End-to-end demo of dynamic dispatch on Aleo.
 *
 * Assumes programs are already deployed (run deploy.ts first).
 *
 * This script:
 *   1. Mints tokens to the sender account
 *   2. Approves the router to spend tokens
 *   3. Routes transfers of toka and tokb via dynamic dispatch
 *   4. Verifies the routed_volume mapping was updated
 *
 * Usage:
 *   DOTENV=devnet npx tsx scripts/demo.ts
 *   DOTENV=canary npx tsx scripts/demo.ts
 */
import { TransactionExecutor } from "../src-ts/client/transaction-executor.js";
import { AleoClient } from "../src-ts/client/aleo-client.js";
import { config } from "../src-ts/config.js";
import { identifierToField } from "../src-ts/utils.js";

const TOKEN_NAMES = ["toka_token", "tokb_token"];
const TOKEN_PROGRAM_IDS = TOKEN_NAMES.map((n) => `${n}.aleo`);
const TOKEN_FIELD_IDS = TOKEN_NAMES.map((n) => identifierToField(n));

async function demo() {
  if (config.privateKeys.length < 2) {
    console.error("Need at least 2 private keys (PRIVATE_KEY_0, PRIVATE_KEY_1) in .env");
    process.exit(1);
  }

  const senderKey = config.privateKeys[0];
  const recipientKey = config.privateKeys[1];

  const aleoClient = new AleoClient();
  const healthy = await aleoClient.healthCheck();
  if (!healthy) {
    console.error(`Cannot reach node at ${config.rpcUrl}`);
    process.exit(1);
  }

  const executor = new TransactionExecutor(aleoClient);
  const senderAddress = executor.getAddress(senderKey);
  const recipientAddress = executor.getAddress(recipientKey);

  console.log(`\nNetwork:   ${config.network}`);
  console.log(`Endpoint:  ${config.rpcUrl}`);
  console.log(`Sender:    ${senderAddress}`);
  console.log(`Recipient: ${recipientAddress}\n`);

  // Check programs are deployed
  for (const name of [...TOKEN_PROGRAM_IDS, config.programId]) {
    if (!(await aleoClient.isProgramDeployed(name))) {
      console.error(`${name} not deployed. Run: npx tsx scripts/deploy.ts`);
      process.exit(1);
    }
  }
  console.log("All programs deployed.\n");

  // ── Step 1: Mint tokens ───────────────────────────────────────────
  console.log("=== Step 1: Mint Tokens ===\n");

  for (const token of TOKEN_PROGRAM_IDS) {
    console.log(`  Minting 10000 ${token} to sender...`);
    const result = await executor.executeOnProgram(
      senderKey,
      token,
      "mint_public",
      [senderAddress, "10000u128"],
    );
    console.log(`  ${token} mint: ${result.status}`);
  }

  // ── Step 2: Approve the router ────────────────────────────────────
  console.log("\n=== Step 2: Approve Router to Spend Tokens ===\n");

  for (const token of TOKEN_PROGRAM_IDS) {
    console.log(`  Approving ${token} for router...`);
    const result = await executor.executeOnProgram(
      senderKey,
      token,
      "approve_public",
      [config.programId, "5000u128"],
    );
    console.log(`  ${token} approve: ${result.status}`);
  }

  // ── Step 3: Route transfers via dynamic dispatch ──────────────────
  const routerExecutor = new TransactionExecutor(aleoClient, config.programId);
  routerExecutor.setExtraImportPrograms(TOKEN_PROGRAM_IDS);

  for (let i = 0; i < TOKEN_NAMES.length; i++) {
    console.log(`\n=== Route ${TOKEN_NAMES[i]} Transfer (Dynamic Dispatch) ===\n`);
    console.log(`  token field ID: ${TOKEN_FIELD_IDS[i]}`);

    const result = await routerExecutor.execute(
      senderKey,
      "route_transfer",
      [TOKEN_FIELD_IDS[i], senderAddress, recipientAddress, "100u128"],
    );
    console.log(`  route_transfer (${TOKEN_NAMES[i]}): ${result.status}`);
    if (result.error) console.log(`  Error: ${result.error}`);
  }

  // ── Step 4: Verify routed_volume mapping ──────────────────────────
  console.log("\n=== Verify routed_volume Mapping ===\n");

  for (let i = 0; i < TOKEN_NAMES.length; i++) {
    const volume = await aleoClient.getMappingValue(
      config.programId,
      "routed_volume",
      TOKEN_FIELD_IDS[i],
    );
    console.log(`  routed_volume[${TOKEN_NAMES[i]}] = ${volume || "(not set)"}`);
  }

  console.log("\n=== Demo Complete ===\n");
  console.log(
    "The same `route_transfer` function handled different token programs\n" +
    "at runtime — that's dynamic dispatch in action!\n",
  );
}

demo().catch(console.error);
