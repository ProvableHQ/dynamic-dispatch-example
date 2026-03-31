import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Account } from "@provablehq/sdk";
import { config } from "../config.js";
import { AleoClient } from "./aleo-client.js";
import { TransactionResult } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_DIR = resolve(__dirname, "../..");
const LEO_BIN = process.env.LEO_BIN || "leo";

/**
 * Transaction executor with two backends (sdk, cli) x two modes (devnet, live):
 *
 * | Backend | Devnet              | Live Network              |
 * |---------|---------------------|---------------------------|
 * | sdk     | buildDevnodeTx      | buildExecutionTransaction |
 * | cli     | leo execute (local) | leo execute (remote)      |
 *
 * Controlled by BACKEND (sdk|cli) and DEVNET (true|false) in .env.
 */
export class TransactionExecutor {
  private aleoClient: AleoClient;
  private programId: string;
  private dynamicImportIds: string[] = [];
  private resolvedImports: Record<string, string> | null = null;

  // SDK state (shared across instances)
  private static sdkInitialized = false;
  private static programManager: any = null;
  private static networkClient: any = null;

  /**
   * @param aleoClient  RPC client
   * @param programId   Program to execute on (default: token_router.aleo)
   * @param dynamicImports  Program IDs called via `call.dynamic` at runtime.
   *   The SDK needs these to fetch program sources for proof generation.
   *   The CLI backend uses them to build the `--with` flag for `leo execute`.
   */
  constructor(aleoClient?: AleoClient, programId?: string, dynamicImports?: string[]) {
    this.aleoClient = aleoClient || new AleoClient();
    this.programId = programId || config.programId;
    this.dynamicImportIds = dynamicImports || [];
  }

  // ── Public API ──────────────────────────────────────────────────

  async execute(
    privateKey: string,
    transition: string,
    inputs: string[],
    fee: number = 1_000_000,
  ): Promise<TransactionResult> {
    return this.dispatch(privateKey, this.programId, transition, inputs, fee);
  }

  async executeOnProgram(
    privateKey: string,
    programName: string,
    transition: string,
    inputs: string[],
    fee: number = 1_000_000,
  ): Promise<TransactionResult> {
    return this.dispatch(privateKey, programName, transition, inputs, fee);
  }

  getAddress(privateKey: string): string {
    return new Account({ privateKey }).address().to_string();
  }

  // ── Dispatch ──────────────────────────────────────────────────

  private dispatch(
    privateKey: string,
    programName: string,
    transition: string,
    inputs: string[],
    fee: number,
  ): Promise<TransactionResult> {
    if (config.backend === "sdk") {
      return this.executeSDK(privateKey, programName, transition, inputs, fee);
    }
    return this.executeCLI(privateKey, programName, transition, inputs, fee);
  }

  // ── SDK backend ──────────────────────────────────────────────

  private async ensureSDK(): Promise<void> {
    if (TransactionExecutor.sdkInitialized) return;
    const { initThreadPool, ProgramManager, AleoKeyProvider, AleoNetworkClient } =
      await import("@provablehq/sdk");
    await initThreadPool();

    // Consensus test heights only needed for devnet
    if (config.devnet) {
      const { getOrInitConsensusVersionTestHeights } = await import("@provablehq/sdk");
      getOrInitConsensusVersionTestHeights("0,1,2,3,4,5,6,7,8,9,10,11,12,13");
    }

    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);
    TransactionExecutor.programManager = new ProgramManager(config.rpcUrl, keyProvider, undefined);
    TransactionExecutor.networkClient = new AleoNetworkClient(config.rpcUrl);
    TransactionExecutor.sdkInitialized = true;
  }

  /**
   * Fetch and cache program sources for dynamic imports.
   * Only needed for the SDK backend — the CLI resolves these from the network.
   */
  private async resolveDynamicImports(): Promise<Record<string, string> | undefined> {
    if (this.dynamicImportIds.length === 0) return undefined;
    if (this.resolvedImports) return this.resolvedImports;
    const imports: Record<string, string> = {};
    for (const id of this.dynamicImportIds) {
      const source = await this.aleoClient.getProgram(id);
      if (source) imports[id] = source;
    }
    this.resolvedImports = imports;
    return imports;
  }

  private async executeSDK(
    privateKey: string,
    programName: string,
    transition: string,
    inputs: string[],
    fee: number,
  ): Promise<TransactionResult> {
    try {
      console.log(`[SDK] Executing ${programName}::${transition}`, inputs);
      await this.ensureSDK();

      const { PrivateKey, Account: Acct } = await import("@provablehq/sdk");
      const programManager = TransactionExecutor.programManager;
      const networkClient = TransactionExecutor.networkClient;
      programManager.setAccount(new Acct({ privateKey }));

      // Provide dynamic import sources when executing the router program
      const imports = programName === this.programId
        ? await this.resolveDynamicImports()
        : undefined;

      const options = {
        programName,
        functionName: transition,
        priorityFee: fee / 1_000_000,
        privateFee: false,
        inputs,
        privateKey: PrivateKey.from_string(privateKey),
        ...(imports ? { imports } : {}),
      };

      // Devnet: skip proof generation. Live: generate real proofs.
      const tx = config.devnet
        ? await programManager.buildDevnodeExecutionTransaction(options)
        : await programManager.buildExecutionTransaction(options);

      const txId = tx.id();
      await networkClient.submitTransaction(tx.toString());
      console.log(`Transaction submitted: ${txId}`);
      const timeout = config.devnet ? 60000 : 180000;
      return this.aleoClient.waitForTransaction(txId, timeout);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Execution error:", msg.substring(0, 500));
      return { transactionId: "", status: "rejected", error: msg };
    }
  }

  // ── CLI backend ──────────────────────────────────────────────

  private buildFlags(privateKey: string, extraFlags: string[] = []): string {
    return [
      `--network ${config.network}`,
      `--endpoint ${config.rpcUrl}`,
      `--private-key ${privateKey}`,
      "--broadcast",
      "-y",
      ...extraFlags,
    ].join(" ");
  }

  /**
   * Build the --with flag value for dynamically-called programs.
   * Resolves program IDs to their local .aleo build artifacts.
   */
  private buildWithFlag(): string | null {
    if (this.dynamicImportIds.length === 0) return null;
    const paths = this.dynamicImportIds.map((id) => {
      const dir = id.replace(/\.aleo$/, "");
      return resolve(PROJECT_DIR, dir, "build/main.aleo");
    });
    return paths.join(",");
  }

  /**
   * Run a leo CLI command from the appropriate program directory.
   * Each program must be run from its own directory so leo can find
   * its program.json and build artifacts.
   */
  private runLeo(command: string, programName?: string, timeoutMs: number = 600000): string {
    const dir = programName ? programName.replace(/\.aleo$/, "") : "";
    const cwd = dir ? resolve(PROJECT_DIR, dir) : PROJECT_DIR;
    console.log(`[CLI] Running: leo ${command.substring(0, 120)}...`);
    try {
      const output = execSync(`${LEO_BIN} ${command}`, {
        cwd,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const txIdMatch = output.match(/(at1[a-z0-9]{58})/);
      if (txIdMatch) return txIdMatch[1];
      console.log("Leo output:", output.substring(0, 500));
      return "";
    } catch (error: unknown) {
      const err = error as { stderr?: string; stdout?: string; message?: string };
      const combined = (err.stdout || "") + (err.stderr || "");
      const txIdMatch = combined.match(/(at1[a-z0-9]{58})/);
      if (txIdMatch) return txIdMatch[1];
      throw new Error(err.stderr || err.stdout || err.message || String(error));
    }
  }

  private async executeCLI(
    privateKey: string,
    programName: string,
    transition: string,
    inputs: string[],
    fee: number,
  ): Promise<TransactionResult> {
    try {
      const inputStr = inputs.map((i) => `'${i}'`).join(" ");
      const extraFlags = [`--priority-fees ${fee}`];

      // Only add --with when executing on a program that has dynamic imports
      if (programName === this.programId) {
        const withFlag = this.buildWithFlag();
        if (withFlag) {
          extraFlags.push(`--with ${withFlag}`);
        }
      }

      const flags = this.buildFlags(privateKey, extraFlags);

      console.log(`[CLI] Executing ${programName}::${transition}`, inputs);
      const txId = this.runLeo(`execute ${transition} ${inputStr} ${flags}`, programName);

      if (!txId) {
        return { transactionId: "", status: "rejected", error: "No transaction ID returned" };
      }
      console.log(`Transaction submitted: ${txId}`);
      return this.aleoClient.waitForTransaction(txId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Execution error:", msg.substring(0, 500));
      return { transactionId: "", status: "rejected", error: msg };
    }
  }
}
