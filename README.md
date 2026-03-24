# Dynamic Dispatch in Leo — Example Project

A minimal, self-contained example showing how to use **dynamic dispatch** (`_dynamic_call`) in Leo programs with full SDK integration. Deploy and run on a local devnet.

---

## What Is Dynamic Dispatch?

In most Leo programs, cross-program calls are **static** — you write `token.aleo/transfer_public(...)` and the compiler knows exactly which program and function you're calling. This works well, but it means your program can only interact with programs it knows about at compile time.

**Dynamic dispatch** breaks this limitation. Instead of hardcoding the target program, you pass a **program ID as a runtime parameter**. The `_dynamic_call` intrinsic resolves the target program at execution time, allowing a single function to call *any* program that implements a compatible interface.

This is the key enabler for generic protocols like DEXs, lending markets, and bridges — any protocol that needs to work with arbitrary tokens or programs deployed after it.

---

## How It Works in Leo

### The `_dynamic_call` Intrinsic

```leo
let future: Final = _dynamic_call::[Final](
    program_id,      // field — which program to call (runtime)
    network_id,      // field — always 1868917857field for .aleo
    function_id,     // field — which function to call (encoded name)
    arg1, arg2, ...  // the function's arguments
);
```

The return type(s) go in the `::[...]` turbofish syntax. Common patterns:

| Pattern | Return | Use Case |
|---------|--------|----------|
| `_dynamic_call::[Final](...)` | Future only | Public transfers |
| `_dynamic_call::[dyn record, Final](...)` | Record + future | Private ↔ public conversions |

### Function ID Constants

Function names are encoded as field elements. These are standard across all ARC-20 tokens:

```leo
const TRANSFER_FROM_PUBLIC_ID: field =
    567541106188061564941814004975800285532843504244field;
const TRANSFER_PUBLIC_TO_PRIVATE_ID: field =
    163031276046149327277138208237194600527678254627957973064970868field;
const TRANSFER_PRIVATE_TO_PUBLIC_ID: field =
    159748619646624572882733203183532374243803035081386454010655348field;
```

### `dyn record` — Type-Erased Records

A `dyn record` is a record whose concrete type is unknown at compile time. When a dynamically-called function returns a record, your program receives it as a `dyn record`. You can pass it to another dynamic call, return it to the caller, or discard it — but you can't access its fields directly (since you don't know its type).

### `Final` Futures and Finalize Blocks

Dynamic calls that modify on-chain state return `Final` futures. These must be executed in a finalize block. **Important:** `final fn` declarations must be placed **outside** the `program { }` block, at file scope:

```leo
program my_program.aleo {
    fn my_transition(...) -> Final {
        let f: Final = _dynamic_call::[Final](...);
        return final { finalize_my_transition(f, ...); };
    }
}

// final fn lives OUTSIDE the program block
final fn finalize_my_transition(transfer_future: Final, ...) {
    transfer_future.run();  // Execute the dynamic call's state changes
    // ... your own state changes ...
}
```

### Token IDs as Field Values

The `token_id` parameter is a **field-encoded program name**, not a string. In snarkVM, `Identifier::to_field()` interprets the UTF-8 bytes of the program name as a little-endian integer:

```typescript
// "toka" -> 1634430836field
function identifierToField(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let result = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    result |= BigInt(bytes[i]) << (BigInt(i) * 8n);
  }
  return result.toString() + "field";
}
```

### Constructor Requirement

Programs deployed after ConsensusV9 must include a constructor:

```leo
program my_program.aleo {
    @noupgrade
    constructor() {}
    // ...
}
```

---

## Code Walkthrough

The example program (`src/main.leo`) implements a **Token Router** with three transitions:

### 1. `route_transfer` — Public Transfer

Routes a `transfer_from_public` call to any ARC-20 token. Demonstrates the simplest dynamic dispatch pattern.

```leo
fn route_transfer(
    public token_id: field,       // Which token program to call
    public from: address,
    public to: address,
    public amount: u128
) -> Final {
    let transfer_future: Final = _dynamic_call::[Final](
        token_id, NETWORK_ALEO, TRANSFER_FROM_PUBLIC_ID,
        from, to, amount
    );
    return final { finalize_route_transfer(transfer_future, ...); };
}
```

### 2. `route_deposit` — Private → Public

Accepts a `dyn record` (a private token record of unknown type) and converts it to a public balance.

```leo
fn route_deposit(
    public token_id: field,
    private token_record: dyn record,    // Type-erased private record
    public amount: u128
) -> (dyn record, Final) {               // Returns change record
    let (change, deposit_future): (dyn record, Final) = _dynamic_call::[dyn record, Final](
        token_id, NETWORK_ALEO, TRANSFER_PRIVATE_TO_PUBLIC_ID,
        self.address, amount, token_record
    );
    return (change, final { ... });
}
```

### 3. `route_withdraw` — Public → Private

Sends public balance as a private record to a recipient.

```leo
fn route_withdraw(
    public token_id: field,
    public recipient: address,
    public amount: u128
) -> (dyn record, Final) {                // Returns new private record
    let (token_record, withdraw_future): (dyn record, Final) = _dynamic_call::[dyn record, Final](
        token_id, NETWORK_ALEO, TRANSFER_PUBLIC_TO_PRIVATE_ID,
        recipient, amount
    );
    return (token_record, final { ... });
}
```

---

## How the SDK Handles Dynamic Dispatch

Programs called via `_dynamic_call` are resolved at **execution time**, not compile time. But the SDK/SnarkVM still needs their bytecode loaded to build the transaction.

The SDK's `resolve_imports` only handles programs in the static `import` list. Since dynamically-called programs aren't imported, we work around this by **injecting fake import statements** into the program source before building the transaction:

```typescript
// Tell the executor which programs will be called dynamically
executor.setExtraImportPrograms(["toka.aleo", "tokb.aleo"]);

// Internally, this prepends:
//   import toka.aleo;
//   import tokb.aleo;
// to the on-chain program source before calling buildDevnodeExecutionTransaction.
// This tricks resolve_imports into loading these programs into the SnarkVM process.
```

See `src-ts/client/transaction-executor.ts` for the full implementation.

---

## Prerequisites

### 1. Leo Compiler (Dynamic Dispatch Branch)

The `_dynamic_call` intrinsic requires a custom Leo compiler branch:

```bash
cd <path-to-leo-repo>
git checkout feat/dynamic_call_instrinsic
cargo build --release -p leo-lang
cp target/release/leo ~/.cargo/bin/leo
```

### 2. SDK (Dynamic Dispatch Branch)

```bash
cd <this-project>
git submodule update --init --recursive

cd sdk
yarn install
yarn build:wasm    # ~20-30 min first time (Rust compilation)
yarn build:sdk     # ~30 sec
cd ..

npm install
```

---

## Quick Start

### 1. Build the Leo program

```bash
leo build
```

### 2. Start the devnode

```bash
leo devnode start --network testnet
```

### 3. Advance to ConsensusV14

Programs using `aleo::GENERATOR` (needed for private operations) require height ≥ 17:

```bash
for i in $(seq 1 17); do leo devnode advance; done
```

### 4. Deploy programs

```bash
npx tsx scripts/deploy.ts
```

> **Important:** Always deploy via the SDK script, not `leo deploy`. The Leo CLI generates verifying keys that are incompatible with the SDK's execution path.

### 5. Run the demo

```bash
npx tsx scripts/demo.ts
```

### 6. Run tests

```bash
npm test
```

---

## Project Structure

```
dynamic-dispatch-example/
├── src/main.leo                          # Token Router (~130 lines)
├── program.json                          # Leo program config
├── build/                                # Generated by `leo build`
├── scripts/
│   ├── token_programs/{toka,tokb}.aleo   # Sample ARC-20 tokens
│   ├── deploy.ts                         # Deploy all programs
│   └── demo.ts                           # End-to-end demo
├── src-ts/
│   ├── client/
│   │   ├── aleo-client.ts                # Devnode RPC client
│   │   └── transaction-executor.ts       # SDK wrapper + dynamic import injection
│   ├── config.ts                         # Environment config
│   └── types.ts                          # TypeScript types
├── tests/router.test.ts                  # Mocha tests
├── sdk/                                  # @provablehq/sdk submodule
├── package.json
└── README.md
```
