# Dynamic Dispatch in Leo — Example Project

A minimal, self-contained example showing how to use **interface-based dynamic dispatch** in Leo programs with full SDK integration.

---

## Prerequisites

### Leo Compiler

Requires a Leo build with interface calls and the `--with` flag for runtime program resolution:

```bash
cd <path-to-leo-repo>
git checkout feat/with-flag-extra-programs
cargo install --path .
```

Verify: `leo --version` should report the correct branch.

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

The CLI backend uses the `--with` flag to provide dynamically-called programs to the VM at runtime.

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

**Dynamic dispatch** breaks this limitation. Instead of hardcoding the target program, you pass a **program ID as a runtime parameter**. An `interface` declaration describes the functions the target program must provide, and the `ARC20@(token_id)::method(...)` syntax resolves the target at execution time. This allows a single function to call *any* program that implements a compatible interface.

This is the key enabler for generic protocols like DEXs, lending markets, and bridges — any protocol that needs to work with arbitrary tokens or programs deployed after it.

---

## How It Works in Leo

### Interfaces

An `interface` declares the contract that target programs must satisfy. This project uses a subset of the [ARC-20 token standard](https://github.com/ProvableHQ/ARCs/discussions/124):

```leo
interface ARC20 {
    record Token;

    fn transfer_from_public(public owner: address, public recipient: address, public amount: u128) -> Final;
    fn transfer_public_to_private(recipient: address, public amount: u128) -> (Token, Final);
    fn transfer_private_to_public(input: Token, to: address, amount: u128) -> (Token, Final);
}
```

Token programs declare that they implement the interface:

```leo
program toka_token.aleo: ARC20 {
    record Token { owner: address, amount: u128 }
    // ... implements all ARC20 functions ...
}
```

### Interface Calls

The router calls functions on any ARC-20 token using `ARC20@(token_id)::method(...)`:

```leo
let transfer_future: Final = ARC20@(token_id)::transfer_from_public(from, to, amount);
```

The `token_id` is a field-encoded program name passed at runtime. The VM resolves which program to call based on this value. No compile-time dependency on the token program is needed.

### `dyn record` — Type-Erased Records

A `dyn record` is a record whose concrete type is unknown at compile time. When the router calls a token program that returns a record, the router receives it as a `dyn record` since it doesn't know the token's concrete `Token` type. You can pass a `dyn record` to another dynamic call or return it to the caller, but you can't access its fields directly.

### `Final` Futures and Finalize Blocks

Dynamic calls that modify on-chain state return `Final` futures. These must be executed in a finalize block. **Important:** `final fn` declarations must be placed **outside** the `program { }` block, at file scope:

```leo
program my_program.aleo {
    fn my_transition(...) -> Final {
        let f: Final = ARC20@(token_id)::transfer_from_public(...);
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

The `token_id` parameter is a **field-encoded program name**. In snarkVM, `Identifier::to_field()` interprets the UTF-8 bytes of the program name as a little-endian integer:

```typescript
function identifierToField(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let result = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    result |= BigInt(bytes[i]) << (BigInt(i) * 8n);
  }
  return result.toString() + "field";
}
// identifierToField("toka_token") => "521331175801343116537716field"
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

The router program (`token_router/src/main.leo`) defines the `ARC20` interface locally and uses it to dispatch calls to any compatible token program at runtime.

### 1. `route_transfer` — Public Transfer

Routes a `transfer_from_public` call to any ARC-20 token. Demonstrates the simplest dynamic dispatch pattern.

```leo
fn route_transfer(
    public token_id: field,
    public from: address,
    public to: address,
    public amount: u128
) -> Final {
    let transfer_future: Final = ARC20@(token_id)::transfer_from_public(from, to, amount);
    return final { finalize_route_transfer(transfer_future, token_id, amount); };
}
```

### 2. `route_deposit` — Private -> Public

Accepts a `dyn record` (a private token record of unknown type) and converts it to a public balance.

```leo
fn route_deposit(
    public token_id: field,
    private token_record: dyn record,
    public amount: u128
) -> (dyn record, Final) {
    let (change, deposit_future): (dyn record, Final) = ARC20@(token_id)::transfer_private_to_public(
        token_record, self.address, amount
    );
    return (change, final { finalize_route_deposit(deposit_future, token_id, amount); });
}
```

### 3. `route_withdraw` — Public -> Private

Sends public balance as a private record to a recipient.

```leo
fn route_withdraw(
    public token_id: field,
    public recipient: address,
    public amount: u128
) -> (dyn record, Final) {
    let (token_record, withdraw_future): (dyn record, Final) = ARC20@(token_id)::transfer_public_to_private(
        recipient, amount
    );
    return (token_record, final { finalize_route_withdraw(withdraw_future, token_id, amount); });
}
```

---

## Project Structure

```
dynamic-dispatch-example/
├── token_router/                         # Token Router program
│   ├── src/main.leo                      # ARC20 interface + 3 transitions
│   └── program.json                      # dev_dependencies on token programs
├── toka_token/                           # Sample ARC-20 token A
│   ├── src/main.leo                      # Implements ARC20 interface
│   └── program.json
├── tokb_token/                           # Sample ARC-20 token B (identical interface)
│   ├── src/main.leo                      # Implements ARC20 interface
│   └── program.json
├── scripts/
│   ├── build-programs.ts                 # Build all programs + copy dev-dep imports
│   ├── deploy.ts                         # Deploy all 3 programs (SDK for devnet, CLI for live)
│   ├── demo.ts                           # End-to-end demo
│   └── preflight.ts                      # Environment validation
├── src-ts/
│   ├── client/
│   │   ├── aleo-client.ts                # RPC client (works with any network)
│   │   └── transaction-executor.ts       # SDK or CLI execution (--with flag for CLI)
│   ├── config.ts                         # Environment config (DOTENV= switching)
│   ├── utils.ts                          # identifierToField() helper
│   └── types.ts                          # TypeScript types
├── tests/router.test.ts                  # Mocha tests (6 scenarios, SDK + CLI)
├── sdk/                                  # @provablehq/sdk submodule
├── package.json
└── README.md
```
