// Record output from a transaction
export interface RecordOutput {
  type: string;
  id: string;
  value: string;
  checksum?: string;
  dynamic_id?: string;
}

// Result of submitting a transaction
export interface TransactionResult {
  transactionId: string;
  status: "accepted" | "rejected" | "pending";
  blockHeight?: number;
  outputs?: RecordOutput[];
  error?: string;
}
