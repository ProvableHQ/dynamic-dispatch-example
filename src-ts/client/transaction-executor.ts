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
const ROUTER_DIR = resolve(PROJECT_DIR, "token_router");

const LEO_BIN = process.env.LEO_BIN || "leo";

/**
 * Transaction executor with two backends:
 *
 * - **Devnet** (DEVNET=true): Uses the SDK's `buildDevnodeExecutionTransaction`
 *   which skips proof generation and matches the VKs from SDK-deployed programs.
 *
 * - **Live networks** (DEVNET unset): Uses `leo execute` CLI which generates
 *   real proofs and works with `leo deploy`-deployed programs on any network.
 */
export class TransactionExecutor {
  private aleoClient: AleoClient;
  private programId: string;

  // SDK state (shared across instances for devnet)
  private static sdkInitialized = false;
  private static programManager: any = null;
  private static networkClient: any = null;
  private extraImportPrograms: string[] = [];
  private cachedImports: Record<string, string> | null = null;

  constructor(aleoClient?: AleoClient, programId?: string) {
    this.aleoClient = aleoClient || new AleoClient();
    this.programId = programId || config.programId;
  }

  /**
   * Register programs called via _dynamic_call at runtime.
   * Only needed for devnet (SDK path) — the leo CLI resolves these from the network.
   */
  setExtraImportPrograms(programIds: string[]): void {
    this.extraImportPrograms = programIds;
    this.cachedImports = null;
  }

  // ── Public API ──────────────────────────────────────────────────

  async execute(
    privateKey: string,
    transition: string,
    inputs: string[],
    fee: number = 1_000_000,
  ): Promise<TransactionResult> {
    if (config.devnet) {
      return this.executeSDK(privateKey, this.programId, transition, inputs, fee);
    }
    return this.executeCLI(privateKey, this.programId, transition, inputs, fee);
  }

  async executeOnProgram(
    privateKey: string,
    programName: string,
    transition: string,
    inputs: string[],
    fee: number = 1_000_000,
  ): Promise<TransactionResult> {
    if (config.devnet) {
      return this.executeSDK(privateKey, programName, transition, inputs, fee);
    }
    return this.executeCLI(privateKey, programName, transition, inputs, fee);
  }

  getAddress(privateKey: string): string {
    return new Account({ privateKey }).address().to_string();
  }

  // ── SDK backend (devnet) ────────────────────────────────────────

  private async ensureSDK(): Promise<void> {
    if (TransactionExecutor.sdkInitialized) return;
    const { initThreadPool, getOrInitConsensusVersionTestHeights, ProgramManager, AleoKeyProvider, AleoNetworkClient } =
      await import("@provablehq/sdk");
    await initThreadPool();
    getOrInitConsensusVersionTestHeights("0,1,2,3,4,5,6,7,8,9,10,11,12,13");
    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);
    TransactionExecutor.programManager = new ProgramManager(config.rpcUrl, keyProvider, undefined);
    TransactionExecutor.networkClient = new AleoNetworkClient(config.rpcUrl);
    TransactionExecutor.sdkInitialized = true;
  }

  private async getExtraImports(): Promise<Record<string, string>> {
    if (this.extraImportPrograms.length === 0) return {};
    if (this.cachedImports) return this.cachedImports;
    const imports: Record<string, string> = {};
    for (const id of this.extraImportPrograms) {
      const source = await this.aleoClient.getProgram(id);
      if (source) imports[id] = source;
    }
    this.cachedImports = imports;
    return imports;
  }

  private async buildProgramWithExtraImports(
    extraImports: Record<string, string>,
    targetProgram: string,
  ): Promise<string | undefined> {
    if (Object.keys(extraImports).length === 0) return undefined;
    const programSource = await this.aleoClient.getProgram(targetProgram);
    if (!programSource) return undefined;
    const importLines = Object.keys(extraImports)
      .filter((id) => !programSource.includes(`import ${id};`))
      .map((id) => `import ${id};`)
      .join("\n");
    if (!importLines) return undefined;
    return importLines + "\n" + programSource;
  }

  private async executeSDK(
    privateKey: string,
    programName: string,
    transition: string,
    inputs: string[],
    fee: number,
  ): Promise<TransactionResult> {
    try {
      console.log(`Executing ${programName}::${transition}`, inputs);
      await this.ensureSDK();

      const { PrivateKey, Account: Acct } = await import("@provablehq/sdk");
      const programManager = TransactionExecutor.programManager;
      const networkClient = TransactionExecutor.networkClient;
      programManager.setAccount(new Acct({ privateKey }));

      // Dynamic dispatch imports (only for router program)
      const extraImports = programName === this.programId ? await this.getExtraImports() : {};
      const mergedImports = Object.keys(extraImports).length > 0 ? extraImports : undefined;
      const modifiedSource = mergedImports
        ? await this.buildProgramWithExtraImports(mergedImports, programName)
        : undefined;

      const tx = await programManager.buildDevnodeExecutionTransaction({
        programName,
        functionName: transition,
        priorityFee: fee / 1_000_000,
        privateFee: false,
        inputs,
        privateKey: PrivateKey.from_string(privateKey),
        imports: mergedImports,
        ...(modifiedSource ? { program: modifiedSource } : {}),
      });

      const txId = tx.id();
      await networkClient.submitTransaction(tx.toString());
      console.log(`Transaction submitted: ${txId}`);
      return this.aleoClient.waitForTransaction(txId, 60000);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Execution error:", msg.substring(0, 300));
      return { transactionId: "", status: "rejected", error: msg };
    }
  }

  // ── CLI backend (live networks) ─────────────────────────────────

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
   * Run a leo CLI command from the appropriate directory.
   * Router commands run from token_router/ so leo resolves dependencies.
   * Other program commands run from the project root.
   */
  private runLeo(command: string, timeoutMs: number = 600000): string {
    // Run from token_router/ for router commands so leo finds program.json with deps
    const isRouterCmd = command.includes(this.programId);
    const cwd = isRouterCmd ? ROUTER_DIR : PROJECT_DIR;
    console.log(`Running: leo ${command.substring(0, 120)}...`);
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
      const functionName = `${programName}/${transition}`;
      const inputStr = inputs.map((i) => `'${i}'`).join(" ");
      const flags = this.buildFlags(privateKey, [`--priority-fees ${fee}`]);

      console.log(`Executing ${programName}::${transition}`, inputs);
      const txId = this.runLeo(`execute ${functionName} ${inputStr} ${flags}`);

      if (!txId) {
        return { transactionId: "", status: "rejected", error: "No transaction ID returned" };
      }
      console.log(`Transaction submitted: ${txId}`);
      return this.aleoClient.waitForTransaction(txId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Execution error:", msg.substring(0, 300));
      return { transactionId: "", status: "rejected", error: msg };
    }
  }
}
