---
name: ubi-circle
description: Trade, launch, and claim on ubi.fun from a Circle Agent Wallet on Arc, so the agent sends its own transactions. Use when the user wants the agent to execute ubi.fun actions itself with a Circle Agent Wallet (Circle CLI), not just prepare them.
---

# ubi.fun with a Circle Agent Wallet

The ubi MCP server prepares unsigned steps (see `ubi-trading` and `ubi-launch`). This skill sends them from a Circle Agent Wallet on Arc with the bundled `scripts/ubi-circle.mjs` (Node.js 20 or newer). Circle signs and submits; the script never sees a key, an email code, or a session token.

Why a script: the Circle CLI only takes "function signature + text arguments", which cannot carry a Universal Router swap or a launch. Circle's API accepts raw calldata, so `setup` installs one pinned Circle CLI version (`@circle-fin/cli@1.2.2`) into `~/.ubi-circle`, checks its hash, and writes a copy beside it that adds `--call-data` for Circle Agent Wallets on ARC. The installed CLI file is not changed, and every other command is the stock CLI.

## One-time setup (the human does this, in their own terminal)

```bash
node scripts/ubi-circle.mjs setup
node scripts/ubi-circle.mjs circle terms show      # read them, then:
node scripts/ubi-circle.mjs circle terms accept
node scripts/ubi-circle.mjs circle wallet login YOUR_EMAIL --type agent
node scripts/ubi-circle.mjs wallets
```

- The login asks for the emailed code in the terminal. Never type that code into an agent chat, and never ask the user for it.
- Do not accept Circle's terms on the user's behalf. Terms and login are the user's steps.
- `wallets` prints the Circle Agent Wallet address on ARC. Fund it with USDC on Arc (https://ubi.fun/bridge moves USDC from other chains). Keep some USDC beyond the trade amount: Arc pays gas in USDC.

## Every action

1. Prepare with the MCP as usual, and use the Circle wallet address wherever the tool asks for the sender or the referrer:
   - `prepare_swap { coin, side, amount, referrer: <circle wallet> }` (the referrer earns 5% of the swap fee)
   - `prepare_launch` / `prepare_launch_v3` with `creator` set to whoever should own the creator earnings (the user's own wallet, or the Circle wallet for an agent that funds itself)
   - claims: `get_referrer_balance`, `get_coin_earnings`, `get_underwater_refunds`, `get_holder_rewards` return their claim steps
2. Show the user what will happen (amount, quote, minimum out, recipient) and get their go for anything that spends money.
3. Save the tool result as JSON and send it:

```bash
node scripts/ubi-circle.mjs send --address <circle wallet> --file steps.json --dry-run   # simulates the first step
node scripts/ubi-circle.mjs send --address <circle wallet> --file steps.json
```

`send` accepts the whole `prepare_*` result, its `steps` array, or one step. For each step in order it simulates against Arc as the chain is at that moment, sends it through Circle, waits for the receipt, and stops at the first failure. Output is JSON with each step's transaction hash and an arc.etherscan.io link.

## When something goes wrong

- `SIMULATION_FAILED`: the step would revert now. Nothing after it was sent. Re-quote and prepare fresh steps (quotes and deadlines go stale).
- `OUTCOME_UNKNOWN`: Circle did not finish cleanly (no transaction hash, or it failed after printing one; a printed hash is in the output). **Do not resend.** The transaction may still land. Check `node scripts/ubi-circle.mjs circle transaction list --address <circle wallet> --chain ARC` and the explorer first.
- `REVERTED` or `PENDING`: stopped before the next step; read the explorer link.
- `RECEIPT_UNKNOWN`: the step was sent (its hash is in the output) but the receipt could not be read. **Do not resend.** Check the explorer link, then prepare fresh steps for anything left.
- `RPC_UNAVAILABLE` or `RPC_INVALID` before a step was sent: the Arc RPC could not be read or gave a malformed answer, so that step was not simulated and not sent. Steps listed under `done` already landed; prepare fresh steps for the rest.
- `CIRCLE_NOT_READY`: no Circle session; the user logs in again in their own terminal.
- `RUNTIME_MISMATCH`: the files in `~/.ubi-circle` changed; run `setup` again.

## Things to know

- Circle Agent Wallets are smart-contract wallets. Trading, launching, referrer earnings, creator earnings, and token dividends all work. Two payouts count only key-controlled wallets: the daily **$UBI holder pool** and **Underwater refunds** on v3 tokens. A Circle Agent Wallet earns neither, so hold $UBI, or v3 tokens you want Underwater cover on, in a regular wallet.
- Nothing here limits spending by itself. Circle's own wallet policies apply; keep only the working balance in the agent wallet.
