import { config } from "../config.js";
import { TransactionResult, RecordOutput } from "../types.js";

/**
 * Aleo RPC client using direct REST calls.
 * Works with any network (testnet, canary, mainnet) by using the
 * configured endpoint and network from .env.
 */
export class AleoClient {
  private endpoint: string;
  private network: string;

  constructor(endpoint?: string, network?: string) {
    this.endpoint = endpoint || config.rpcUrl;
    this.network = network || config.network;
  }

  private apiUrl(path: string): string {
    return `${this.endpoint}/${this.network}${path}`;
  }

  async getLatestBlockHeight(): Promise<number> {
    const response = await fetch(this.apiUrl("/block/latest"));
    const block = (await response.json()) as {
      header?: { metadata?: { height?: number } };
    };
    const height = block?.header?.metadata?.height;
    if (typeof height === "number") return height;
    throw new Error("Could not determine block height");
  }

  async getMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string | null> {
    try {
      const url = this.apiUrl(`/program/${programId}/mapping/${mappingName}/${key}`);
      const response = await fetch(url);
      if (!response.ok) return null;
      const text = await response.text();
      // The API returns the value as JSON (e.g. "100u128" with quotes)
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      return null;
    }
  }

  async isProgramDeployed(programId: string): Promise<boolean> {
    try {
      const url = this.apiUrl(`/program/${programId}`);
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  async getProgram(programId: string): Promise<string | null> {
    try {
      const url = this.apiUrl(`/program/${programId}`);
      const response = await fetch(url);
      if (!response.ok) return null;
      const text = await response.text();
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      return null;
    }
  }

  async getTransaction(transactionId: string): Promise<Record<string, unknown> | null> {
    try {
      const url = this.apiUrl(`/transaction/${transactionId}`);
      const response = await fetch(url);
      if (!response.ok) return null;
      return await response.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async waitForTransaction(
    transactionId: string,
    timeoutMs: number = 180000,
    pollIntervalMs: number = 3000,
  ): Promise<TransactionResult> {
    const startTime = Date.now();
    console.log(`Waiting for transaction ${transactionId}...`);

    while (Date.now() - startTime < timeoutMs) {
      const txObj = await this.getTransaction(transactionId);
      if (txObj) {
        // Rejected: fee-only transaction
        if (txObj.type === "fee") {
          return { transactionId, status: "rejected", error: "Finalize failed (fee-only tx)" };
        }
        // Rejected: explicit rejected field
        if ((txObj.type === "execute" || txObj.type === "deploy") && txObj.rejected !== undefined) {
          return { transactionId, status: "rejected", error: `Finalize failed: ${JSON.stringify(txObj.rejected)}` };
        }

        const outputs = this.extractRecordOutputs(txObj);
        return {
          transactionId,
          status: "accepted",
          blockHeight: typeof txObj.block_height === "number" ? txObj.block_height : undefined,
          outputs,
        };
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed % 15 === 0 && elapsed > 0) {
        console.log(`  Still waiting... (${elapsed}s)`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return { transactionId, status: "pending", error: "Timeout" };
  }

  private extractRecordOutputs(txObj: Record<string, unknown>): RecordOutput[] {
    const outputs: RecordOutput[] = [];
    try {
      const execution = txObj.execution as {
        transitions?: Array<{
          outputs?: Array<{
            type: string;
            id: string;
            value: string;
            checksum?: string;
            dynamic_id?: string;
          }>;
        }>;
      };
      if (execution?.transitions) {
        for (const transition of execution.transitions) {
          if (transition.outputs) {
            for (const output of transition.outputs) {
              if (output.value) {
                outputs.push({
                  type: output.type,
                  id: output.id,
                  value: output.value,
                  checksum: output.checksum,
                  dynamic_id: output.dynamic_id,
                });
              }
            }
          }
        }
      }
    } catch {
      // ignore extraction errors
    }
    return outputs;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const height = await this.getLatestBlockHeight();
      console.log(`Node at ${this.endpoint} (${this.network}, height: ${height})`);
      return true;
    } catch {
      console.log(`Cannot reach node at ${this.endpoint}`);
      return false;
    }
  }
}
