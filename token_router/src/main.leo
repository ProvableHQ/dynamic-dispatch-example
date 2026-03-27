// Token Router — A minimal example of dynamic dispatch in Leo.
//
// This program routes token operations to ANY ARC-20 token program at runtime,
// without knowing the token program at compile time. The token program ID is
// passed as a field parameter — the `_dynamic_call` intrinsic resolves it at
// execution time.
//
// Three transitions demonstrate the three core dynamic dispatch patterns:
//   1. route_transfer  — _dynamic_call::[Final]            (public transfer)
//   2. route_deposit   — dyn record input, returns change   (private → public)
//   3. route_withdraw  — returns dyn record output          (public → private)

program token_router.aleo {

    // ── Constants ────────────────────────────────────────────────────
    // Network ID for all .aleo programs (fixed encoding).
    const NETWORK_ALEO: field = 1868917857field;

    // ARC-20 function IDs — field-encoded function names.
    // These are the same constants used by the AMM and any program that
    // dynamically dispatches to ARC-20 tokens.
    const TRANSFER_FROM_PUBLIC_ID: field =
        567541106188061564941814004975800285532843504244field;
    const TRANSFER_PUBLIC_TO_PRIVATE_ID: field =
        163031276046149327277138208237194600527678254627957973064970868field;
    const TRANSFER_PRIVATE_TO_PUBLIC_ID: field =
        159748619646624572882733203183532374243803035081386454010655348field;

    @noupgrade
    constructor() {}

    // ── State ────────────────────────────────────────────────────────
    // Tracks cumulative routed volume per token program (for verification).
    mapping routed_volume: field => u128;

    // ── Transition 1: Public Transfer ────────────────────────────────
    // Routes a `transfer_from_public` call to any ARC-20 token.
    //
    // The caller must first approve this program (token_router.aleo) to
    // spend their tokens via the token program's `approve_public`.
    //
    // Pattern: _dynamic_call::[Final](...) — single future return.
    fn route_transfer(
        public token_id: field,
        public from: address,
        public to: address,
        public amount: u128
    ) -> Final {
        // Dynamically call `transfer_from_public(from, to, amount)` on the
        // token program identified by `token_id`.
        let transfer_future: Final = _dynamic_call::[Final](
            token_id,
            NETWORK_ALEO,
            TRANSFER_FROM_PUBLIC_ID,
            from,
            to,
            amount
        );

        return final {
            finalize_route_transfer(transfer_future, token_id, amount);
        };
    }

    // ── Transition 2: Deposit (private → public) ─────────────────────
    // Accepts a private token record and converts it to public balance
    // held by this program.
    //
    // Pattern: _dynamic_call::[dyn record, Final](...) with `dyn record` input.
    // The `dyn record` is a type-erased record — its concrete type is resolved
    // at runtime based on `token_id`.
    fn route_deposit(
        public token_id: field,
        private token_record: dyn record,
        public amount: u128
    ) -> (dyn record, Final) {
        // Dynamically call `transfer_private_to_public(recipient, amount, record)`
        // on the token program. Returns (change_record, future).
        let (change, deposit_future): (dyn record, Final) = _dynamic_call::[address, u128, dyn record, (dyn record, Final)](
            token_id,
            NETWORK_ALEO,
            TRANSFER_PRIVATE_TO_PUBLIC_ID,
            self.address,
            amount,
            token_record
        );

        return (change, final {
            finalize_route_deposit(deposit_future, token_id, amount);
        });
    }

    // ── Transition 3: Withdraw (public → private) ────────────────────
    // Sends public balance held by this program as a private record
    // to the recipient.
    //
    // Pattern: _dynamic_call::[dyn record, Final](...) returning `dyn record`.
    fn route_withdraw(
        public token_id: field,
        public recipient: address,
        public amount: u128
    ) -> (dyn record, Final) {
        // Dynamically call `transfer_public_to_private(recipient, amount)`
        // on the token program. Returns (token_record, future).
        let (token_record, withdraw_future): (dyn record, Final) = _dynamic_call::[address, u128, (dyn record, Final)](
            token_id,
            NETWORK_ALEO,
            TRANSFER_PUBLIC_TO_PRIVATE_ID,
            recipient,
            amount
        );

        return (token_record, final {
            finalize_route_withdraw(withdraw_future, token_id, amount);
        });
    }
}

// ── Finalize Functions ───────────────────────────────────────────────
// In Leo, `final fn` declarations live outside the `program` block.
// They execute on-chain after the transition completes, and can access
// mappings and run futures from dynamic calls.

final fn finalize_route_transfer(
    transfer_future: Final,
    token_id: field,
    amount: u128
) {
    // Execute the dynamically dispatched transfer.
    transfer_future.run();
    // Track cumulative volume.
    let current: u128 = Mapping::get_or_use(routed_volume, token_id, 0u128);
    routed_volume.set(token_id, current + amount);
}

final fn finalize_route_deposit(
    deposit_future: Final,
    token_id: field,
    amount: u128
) {
    deposit_future.run();
    let current: u128 = Mapping::get_or_use(routed_volume, token_id, 0u128);
    routed_volume.set(token_id, current + amount);
}

final fn finalize_route_withdraw(
    withdraw_future: Final,
    token_id: field,
    amount: u128
) {
    withdraw_future.run();
    let current: u128 = Mapping::get_or_use(routed_volume, token_id, 0u128);
    routed_volume.set(token_id, current + amount);
}
