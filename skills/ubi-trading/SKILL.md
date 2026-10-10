---
name: ubi-trading
description: Discover, quote, and trade ubi.fun tokens on Arc mainnet via the ubi MCP server, and earn 5% of the swap fee on every trade you route by setting yourself as the referrer. Use when buying or selling ubi.fun tokens, checking prices or markets, or checking referrer or holder earnings.
---

# Trade on ubi.fun

Connect the MCP server first (see the `ubi` skill). All amounts are human units: USDC amounts like `"25"` or `"12.5"`, token amounts likewise.

## Always set the referrer

Every quote and swap accepts `referrer`. Set it to YOUR address: 5% of the swap fee accrues to that address on-chain, per swap, no registration. Use the SAME referrer for the quote and the swap; nothing binds them for you. Rewards accrue in the swap OUTPUT token (buys accrue the token, sells accrue USDC); `get_referrer_balance` always checks USDC, checks any tokens you pass, and returns one claim transaction for all of them.

## Workflow

1. **Discover**: `get_coins` (`sort=new` for latest launches, `q` to search). `get_coin` for one token's price, market cap, 24h stats, and fair launch state. `get_candles` for trend.
2. **Quote**: `quote_swap { coin, side: "buy"|"sell", amount, referrer }`. Buys spend USDC, sells spend the token. The quote is net of the token's swap fee (1.25% on older tokens, 1.5% to 5% on tokens launched since October 4, 2026).
3. **Execute**: `prepare_swap { coin, side, amount, slippageBps?, referrer }` returns two unsigned steps: an ERC20 approve of the input token to the PoolSwap router, then the swap. Simulate each, then sign and send in order with your wallet tooling. Default slippage is 500 bps; tighten for large pools.
4. **Verify**: the swap appears in `get_coin`'s 24h stats and the token's activity within seconds.

## Holder income

- **Token dividends**: every token launched since October 4, 2026 has a creator vault that pays part of each fee to everyone holding that token, in USDC, released over 24 hours after each harvest. Withdraw on the token's page at ubi.fun. Pools, protocol contracts and the burn address don't earn; smart-contract wallets do.
- **$UBI holder pool**: once a day, the holder pool pays USDC to $UBI holders by time-weighted balance, funded by fees from every token on the platform. Holding other tokens does not earn from it. Payouts are sent to wallets automatically. Safes and other deployed contracts are not counted (regular wallets upgraded with EIP-7702 are). `get_holder_rewards { address }` returns the entitlement, what the address already received, and a claim transaction only if something is still outstanding.

## Failure modes

- "Pool has no observed price yet": the token has never traded; wait for its first trade before preparing a swap.
- During a token's fair launch window, fills happen at the fixed launch price; quotes still work.
- Rate limited per IP; back off on 429.
