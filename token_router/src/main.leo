// Token Router — A minimal example of dynamic dispatch in Leo.
//
// This program routes token operations to ANY ARC-20 token program at runtime,
// without knowing the token program at compile time. The token program ID is
// passed as a field parameter — the interface call resolves it at execution time.
//
// Three transitions demonstrate the three core dynamic dispatch patterns:
//   1. route_transfer  — public transfer returning Final
//   2. route_deposit   — dyn record input, returns change (private → public)
//   3. route_withdraw  — returns dyn record output (public → private)

interface ARC20 {
    record Token;

    fn transfer_from_public(public owner: address, public recipient: address, public amount: u128) -> Final;
    fn transfer_public_to_private(recipient: address, public amount: u128) -> (dyn record, Final);
    fn transfer_private_to_public(input: dyn record, to: address, amount: u128) -> (dyn record, Final);
}

program token_router.aleo {

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
    fn route_transfer(
        public token_id: field,
        public from: address,
        public to: address,
        public amount: u128
    ) -> Final {
        let transfer_future: Final = ARC20@(token_id)::transfer_from_public(from, to, amount);

        return final {
            finalize_route_transfer(transfer_future, token_id, amount);
        };
    }

    // ── Transition 2: Deposit (private → public) ─────────────────────
    // Accepts a private token record and converts it to public balance
    // held by this program.
    fn route_deposit(
        public token_id: field,
        private token_record: dyn record,
        public amount: u128
    ) -> (dyn record, Final) {
        let (change, deposit_future): (dyn record, Final) = ARC20@(token_id)::transfer_private_to_public(
            token_record,
            self.address,
            amount
        );

        return (change, final {
            finalize_route_deposit(deposit_future, token_id, amount);
        });
    }

    // ── Transition 3: Withdraw (public → private) ────────────────────
    // Sends public balance held by this program as a private record
    // to the recipient.
    fn route_withdraw(
        public token_id: field,
        public recipient: address,
        public amount: u128
    ) -> (dyn record, Final) {
        let (token_record, withdraw_future): (dyn record, Final) = ARC20@(token_id)::transfer_public_to_private(
            recipient,
            amount
        );

        return (token_record, final {
            finalize_route_withdraw(withdraw_future, token_id, amount);
        });
    }
}

// ── Finalize Functions ───────────────────────────────────────────────

final fn finalize_route_transfer(
    transfer_future: Final,
    token_id: field,
    amount: u128
) {
    transfer_future.run();
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
