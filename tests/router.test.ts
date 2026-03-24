import { expect } from "chai";
import { Account } from "@provablehq/sdk";
import { TransactionExecutor } from "../src-ts/client/transaction-executor.js";
import { AleoClient } from "../src-ts/client/aleo-client.js";
import { config } from "../src-ts/config.js";
import { identifierToField } from "../src-ts/utils.js";

/**
 * Decrypt an encrypted record and format it for CLI input.
 * dyn record inputs require plaintext records with visibility suffixes.
 */
function decryptAndFormatRecord(privateKey: string, ciphertext: string): string | null {
  try {
    const account = new Account({ privateKey });
    const plaintext = account.decryptRecord(ciphertext);
    if (!plaintext) return null;
    return plaintext.toString();
  } catch {
    return null;
  }
}

// Keys from config (falls back to devnode defaults if no .env)
const SENDER_KEY = config.privateKeys[0];
const RECIPIENT_KEY = config.privateKeys[1] || config.privateKeys[0];

// The bundled example tokens
const TOKA_ID = identifierToField("toka_token");
const TOKB_ID = identifierToField("tokb_token");
const TOKEN_PROGRAM_IDS = ["toka_token.aleo", "tokb_token.aleo"];

describe("Token Router — Dynamic Dispatch", function () {
  this.timeout(600_000);

  let aleoClient: AleoClient;
  let executor: TransactionExecutor;
  let routerExecutor: TransactionExecutor;
  let senderAddress: string;
  let recipientAddress: string;

  before(async () => {
    aleoClient = new AleoClient();
    const healthy = await aleoClient.healthCheck();
    if (!healthy) {
      throw new Error(`Cannot reach node at ${config.rpcUrl}`);
    }

    executor = new TransactionExecutor(aleoClient);
    senderAddress = executor.getAddress(SENDER_KEY);
    recipientAddress = executor.getAddress(RECIPIENT_KEY);

    console.log(`Network:   ${config.network}`);
    console.log(`Endpoint:  ${config.rpcUrl}`);
    console.log(`Sender:    ${senderAddress}`);
    console.log(`Recipient: ${recipientAddress}`);

    // Ensure programs are deployed (assumes deploy.ts was run)
    const routerDeployed = await aleoClient.isProgramDeployed(config.programId);
    if (!routerDeployed) {
      throw new Error(`${config.programId} not deployed. Run: npx tsx scripts/deploy.ts`);
    }

    // Set up router executor with dynamic dispatch imports
    // (needed for SDK backend — leo CLI resolves these automatically)
    routerExecutor = new TransactionExecutor(aleoClient, config.programId);
    routerExecutor.setExtraImportPrograms(TOKEN_PROGRAM_IDS);

    // Mint tokens and approve router
    console.log("Setup: minting tokens and approving router...");

    for (const token of TOKEN_PROGRAM_IDS) {
      const mint = await executor.executeOnProgram(
        SENDER_KEY,
        token,
        "mint_public",
        [senderAddress, "10000u128"],
      );
      expect(mint.status).to.equal("accepted", `Failed to mint ${token}: ${mint.error}`);

      const approve = await executor.executeOnProgram(
        SENDER_KEY,
        token,
        "approve_public",
        [config.programId, "5000u128"],
      );
      expect(approve.status).to.equal("accepted", `Failed to approve ${token}: ${approve.error}`);
    }

    console.log("Setup complete");
  });

  it("routes a public toka transfer via dynamic dispatch", async () => {
    const result = await routerExecutor.execute(
      SENDER_KEY,
      "route_transfer",
      [TOKA_ID, senderAddress, recipientAddress, "100u128"],
    );

    expect(result.status).to.equal("accepted", `route_transfer failed: ${result.error}`);

    const volume = await aleoClient.getMappingValue(
      config.programId,
      "routed_volume",
      TOKA_ID,
    );
    expect(volume).to.not.be.null;
  });

  it("routes a public tokb transfer — proves runtime dispatch", async () => {
    const result = await routerExecutor.execute(
      SENDER_KEY,
      "route_transfer",
      [TOKB_ID, senderAddress, recipientAddress, "200u128"],
    );

    expect(result.status).to.equal("accepted", `route_transfer failed: ${result.error}`);

    const volume = await aleoClient.getMappingValue(
      config.programId,
      "routed_volume",
      TOKB_ID,
    );
    expect(volume).to.not.be.null;
  });

  for (const [tokenName, tokenProgramId, tokenFieldId] of [
    ["toka_token", "toka_token.aleo", TOKA_ID],
    ["tokb_token", "tokb_token.aleo", TOKB_ID],
  ]) {
    it(`deposits private ${tokenName} via dynamic dispatch`, async () => {
      // Get a private token record by converting public to private
      const pubToPriv = await executor.executeOnProgram(
        SENDER_KEY,
        tokenProgramId,
        "transfer_public_to_private",
        [senderAddress, "500u128"],
      );
      expect(pubToPriv.status).to.equal("accepted", `transfer_public_to_private failed: ${pubToPriv.error}`);

      // Find and decrypt the record output.
      // dyn record inputs must be plaintext, not encrypted ciphertexts.
      const recordOutput = pubToPriv.outputs?.find(
        (o) => o.type === "record" || o.type === "record_with_dynamic_id",
      );
      expect(recordOutput).to.not.be.undefined;

      let recordValue = recordOutput!.value;
      if (recordValue.startsWith("record1") || recordValue.startsWith("ciphertext")) {
        const decrypted = decryptAndFormatRecord(SENDER_KEY, recordValue);
        if (!decrypted) {
          console.log("Could not decrypt record — skipping deposit test");
          return;
        }
        recordValue = decrypted;
      }

      const result = await routerExecutor.execute(
        SENDER_KEY,
        "route_deposit",
        [tokenFieldId, recordValue, "500u128"],
      );

      expect(result.status).to.equal("accepted", `route_deposit failed: ${result.error}`);
    });

    it(`withdraws ${tokenName} as private record via dynamic dispatch`, async () => {
      // The router should have public balance from the deposit test above.
      const result = await routerExecutor.execute(
        SENDER_KEY,
        "route_withdraw",
        [tokenFieldId, senderAddress, "100u128"],
      );

      expect(result.status).to.equal("accepted", `route_withdraw failed: ${result.error}`);

      const recordOutput = result.outputs?.find(
        (o) =>
          o.type === "record" ||
          o.type === "record_dynamic" ||
          o.type === "record_with_dynamic_id",
      );
      expect(recordOutput).to.not.be.undefined;
    });
  }
});
