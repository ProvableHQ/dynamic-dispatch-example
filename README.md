# Dynamic Dispatch in Leo — Example Project

A minimal, self-contained example showing how to use **dynamic dispatch** (`_dynamic_call`) in Leo programs with full SDK integration.

---

## Prerequisites

### Leo Compiler

Requires the `feat/dynamic-dispatch-intrinsics` branch of Leo (or any build that includes the dynamic call intrinsics and record translation VK support):

```bash
cd <path-to-leo-repo>
git checkout feat/dynamic-dispatch-intrinsics
cargo install --path .
```

Verify: `leo --version` should report the `feat/dynamic-dispatch-intrinsics` branch.

### SDK

```bash
npm install
```

This installs `@provablehq/sdk` v0.10.0 and its prebuilt WASM from npm. No build-from-source step required.

### Preflight Check

Verify everything is set up correctly:

```bash
DOTENV=devnet npm run preflight    # for local development
DOTENV=testnet npm run preflight   # for testnet
```

---

## Execution Backends

Two backends (`BACKEND`), two network modes (`DEVNET`):

| | **SDK** (`BACKEND=sdk`) | **Leo CLI** (`BACKEND=cli`) |
|---|---|---|
| **Devnet** (`DEVNET=true`) | No proofs, fastest iteration | Real proofs, local node |
| **Live** (`DEVNET=false`) | Real proofs via WASM | Real proofs via `leo execute` |

Defaults: `sdk` on devnet, `cli` on live. Override with `BACKEND` in your `.env` file.

---

## Local Development (devnet)

### 1. Start the devnode

```bash
leo devnode start --network testnet \
  --consensus-heights "0,1,2,3,4,5,6,7,8,9,10,11,12,13" \
  --private-key APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH
```

### 2. Build, deploy, test

```bash
DOTENV=devnet npm run build:leo
DOTENV=devnet npm run deploy          # default: BACKEND=sdk (no proofs)
DOTENV=devnet npm test
```

To generate real proofs against the local devnode instead:

```bash
DOTENV=devnet BACKEND=cli npm run deploy
DOTENV=devnet BACKEND=cli npm test
```

---

## Live Networks (testnet / canary)

### 1. Configure environment

Create `.env.testnet` (or `.env.canary`):

```env
NETWORK=testnet
ENDPOINT=https://api.explorer.provable.com/v2
DEVNET=false
PRIVATE_KEY_0=APrivateKey1...   # deployer / sender
PRIVATE_KEY_1=APrivateKey1...   # recipient (for tests)
```

### 2. Build, deploy, test

```bash
DOTENV=testnet npm run build:leo
DOTENV=testnet npm run deploy          # default: BACKEND=cli (leo deploy)
DOTENV=testnet npm test                # ~5 min (proof generation + block confirmation)
```

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
    network_id,      // 'aleo' — identifier literal, compiles to 1868917857field
    function_id,     // field — which function to call (encoded name)
    arg1, arg2, ...  // the function's arguments
);
```

The turbofish `::[...]` lists the **input types**, then the **return type** as the last element. When the function returns multiple values, wrap the return in a tuple. For example, calling `transfer_private_to_public(to: address, amount: u128, token: Token) -> (Token, Final)`:

```leo
let (change, future): (dyn record, Final) = _dynamic_call::[address, u128, dyn record, (dyn record, Final)](
    token_id, 'aleo', 'transfer_private_to_public',
    self.address, amount, token_record
);
```

Common patterns:

| Turbofish | Meaning |
|-----------|---------|
| `::[Final]` | No inputs, returns a future |
| `::[address, u128, Final]` | Two inputs, returns a future |
| `::[address, u128, dyn record, (dyn record, Final)]` | Three inputs, returns a record + future |

### Function ID Constants

Function names are field-encoded the same way as program names (see `identifierToField` below). For example, `identifierToField("transfer_from_public")` produces the first constant. These are standard across all ARC-20 tokens:

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

The router program (`token_router/src/main.leo`) implements a **Token Router** with three transitions:

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

### 2. `route_deposit` — Private -> Public

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

### 3. `route_withdraw` — Public -> Private

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

## Project Structure

```
dynamic-dispatch-example/
├── token_router/                         # Token Router program
│   ├── src/main.leo                      # 3 transitions: route_transfer, route_deposit, route_withdraw
│   └── program.json
├── toka_token/                           # Sample ARC-20 token A
│   ├── src/main.leo
│   └── program.json
├── tokb_token/                           # Sample ARC-20 token B (identical interface)
│   ├── src/main.leo
│   └── program.json
├── scripts/
│   ├── build-programs.ts                 # Build all Leo programs + copy imports
│   ├── deploy.ts                         # Deploy all 3 programs (SDK for devnet, CLI for live)
│   ├── demo.ts                           # End-to-end demo
│   └── preflight.ts                      # Environment validation
├── src-ts/
│   ├── client/
│   │   ├── aleo-client.ts                # RPC client (works with any network)
│   │   └── transaction-executor.ts       # SDK (devnet) or CLI (live) execution
│   ├── config.ts                         # Environment config (DOTENV= switching)
│   ├── utils.ts                          # identifierToField() helper
│   └── types.ts                          # TypeScript types
├── tests/router.test.ts                  # Mocha tests (6 scenarios)
├── sdk/                                  # @provablehq/sdk submodule
├── package.json
└── README.md
```
