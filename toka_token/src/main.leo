// Minimal ARC-20 token for dynamic dispatch examples.

interface ARC20 {
    record Token;

    fn approve_public(public spender: address, public amount: u128) -> Final;
    fn unapprove_public(public spender: address, public amount: u128) -> Final;
    fn transfer_from_public(public owner: address, public recipient: address, public amount: u128) -> Final;
    fn transfer_public_to_private(recipient: address, public amount: u128) -> (Token, Final);
    fn transfer_private_to_public(input: Token, to: address, amount: u128) -> (Token, Final);
}

program toka_token.aleo: ARC20 {

    record Token {
        owner: address,
        amount: u128,
    }

    struct Allowance {
        account: address,
        spender: address,
    }

    mapping balances: address => u128;
    mapping approvals: field => u128;

    @noupgrade
    constructor() {}

    fn approve_public(public spender: address, public amount: u128) -> Final {
        let key: field = BHP256::hash_to_field(Allowance { account: self.signer, spender });
        return final {
            let current: u128 = Mapping::get_or_use(approvals, key, 0u128);
            approvals.set(key, current + amount);
        };
    }

    fn unapprove_public(public spender: address, public amount: u128) -> Final {
        let key: field = BHP256::hash_to_field(Allowance { account: self.signer, spender });
        return final {
            let current: u128 = approvals.get(key);
            approvals.set(key, current - amount);
        };
    }

    fn transfer_from_public(public owner: address, public recipient: address, public amount: u128) -> Final {
        let key: field = BHP256::hash_to_field(Allowance { account: owner, spender: self.caller });
        return final {
            let allowance: u128 = approvals.get(key);
            approvals.set(key, allowance - amount);
            let from_bal: u128 = Mapping::get_or_use(balances, owner, 0u128);
            assert(from_bal >= amount);
            balances.set(owner, from_bal - amount);
            let to_bal: u128 = Mapping::get_or_use(balances, recipient, 0u128);
            balances.set(recipient, to_bal + amount);
        };
    }

    fn transfer_public_as_signer(to: address, amount: u128) -> Final {
        let from: address = self.signer;
        return final {
            let from_bal: u128 = Mapping::get_or_use(balances, from, 0u128);
            assert(from_bal >= amount);
            balances.set(from, from_bal - amount);
            let to_bal: u128 = Mapping::get_or_use(balances, to, 0u128);
            balances.set(to, to_bal + amount);
        };
    }

    fn transfer_public(to: address, amount: u128) -> Final {
        let from: address = self.caller;
        return final {
            let from_bal: u128 = Mapping::get_or_use(balances, from, 0u128);
            assert(from_bal >= amount);
            balances.set(from, from_bal - amount);
            let to_bal: u128 = Mapping::get_or_use(balances, to, 0u128);
            balances.set(to, to_bal + amount);
        };
    }

    fn transfer_public_to_private(recipient: address, public amount: u128) -> (Token, Final) {
        let token: Token = Token { owner: recipient, amount };
        let from: address = self.caller;
        return (token, final {
            let bal: u128 = Mapping::get_or_use(balances, from, 0u128);
            assert(bal >= amount);
            balances.set(from, bal - amount);
        });
    }

    fn transfer_private_to_public(input: Token, to: address, amount: u128) -> (Token, Final) {
        let change: Token = Token { owner: input.owner, amount: input.amount - amount };
        return (change, final {
            let bal: u128 = Mapping::get_or_use(balances, to, 0u128);
            balances.set(to, bal + amount);
        });
    }

    fn mint_public(public to: address, public amount: u128) -> Final {
        return final {
            let bal: u128 = Mapping::get_or_use(balances, to, 0u128);
            balances.set(to, bal + amount);
        };
    }
}
