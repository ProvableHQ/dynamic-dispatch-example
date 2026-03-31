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
        return final { fin_approve_public(amount, key); };
    }

    fn unapprove_public(public spender: address, public amount: u128) -> Final {
        let key: field = BHP256::hash_to_field(Allowance { account: self.signer, spender });
        return final { fin_unapprove_public(amount, key); };
    }

    fn transfer_from_public(public owner: address, public recipient: address, public amount: u128) -> Final {
        let key: field = BHP256::hash_to_field(Allowance { account: owner, spender: self.caller });
        return final { fin_transfer_from_public(owner, recipient, amount, key); };
    }

    fn transfer_public_as_signer(to: address, amount: u128) -> Final {
        let from: address = self.signer;
        return final { fin_transfer_pub_as_signer(from, to, amount); };
    }

    fn transfer_public(to: address, amount: u128) -> Final {
        let from: address = self.caller;
        return final { fin_transfer_public(from, to, amount); };
    }

    fn transfer_public_to_private(recipient: address, public amount: u128) -> (Token, Final) {
        let token: Token = Token { owner: recipient, amount };
        let from: address = self.caller;
        return (token, final { fin_transfer_pub_to_priv(from, amount); });
    }

    fn transfer_private_to_public(input: Token, to: address, amount: u128) -> (Token, Final) {
        let change: Token = Token { owner: input.owner, amount: input.amount - amount };
        return (change, final { fin_transfer_priv_to_pub(to, amount); });
    }

    fn mint_public(public to: address, public amount: u128) -> Final {
        return final { fin_mint_public(to, amount); };
    }
}

final fn fin_approve_public(amount: u128, key: field) {
    let current: u128 = Mapping::get_or_use(approvals, key, 0u128);
    approvals.set(key, current + amount);
}

final fn fin_unapprove_public(amount: u128, key: field) {
    let current: u128 = approvals.get(key);
    approvals.set(key, current - amount);
}

final fn fin_transfer_from_public(from: address, to: address, amount: u128, key: field) {
    let allowance: u128 = approvals.get(key);
    approvals.set(key, allowance - amount);
    let from_bal: u128 = Mapping::get_or_use(balances, from, 0u128);
    assert(from_bal >= amount);
    balances.set(from, from_bal - amount);
    let to_bal: u128 = Mapping::get_or_use(balances, to, 0u128);
    balances.set(to, to_bal + amount);
}

final fn fin_transfer_pub_as_signer(from: address, to: address, amount: u128) {
    let from_bal: u128 = Mapping::get_or_use(balances, from, 0u128);
    assert(from_bal >= amount);
    balances.set(from, from_bal - amount);
    let to_bal: u128 = Mapping::get_or_use(balances, to, 0u128);
    balances.set(to, to_bal + amount);
}

final fn fin_transfer_public(from: address, to: address, amount: u128) {
    let from_bal: u128 = Mapping::get_or_use(balances, from, 0u128);
    assert(from_bal >= amount);
    balances.set(from, from_bal - amount);
    let to_bal: u128 = Mapping::get_or_use(balances, to, 0u128);
    balances.set(to, to_bal + amount);
}

final fn fin_transfer_priv_to_pub(to: address, amount: u128) {
    let bal: u128 = Mapping::get_or_use(balances, to, 0u128);
    balances.set(to, bal + amount);
}

final fn fin_transfer_pub_to_priv(from: address, amount: u128) {
    let bal: u128 = Mapping::get_or_use(balances, from, 0u128);
    assert(bal >= amount);
    balances.set(from, bal - amount);
}

final fn fin_mint_public(to: address, amount: u128) {
    let bal: u128 = Mapping::get_or_use(balances, to, 0u128);
    balances.set(to, bal + amount);
}
