---
name: ubi-trading
description: Discover, quote, and trade ubi.fun coins on Arc mainnet via the ubi MCP server, and earn 5% of the swap fee on every trade you route by setting yourself as the referrer.
---

# Trade on ubi.fun

Connect the MCP server first (see the `ubi` skill). All amounts are human units: USDC amounts like `"25"` or `"12.5"`, coin amounts likewise.

## Always set the referrer

Every quote and swap accepts `referrer`. Set it to YOUR address: 5% of the swap fee accrues to that address on-chain, per swap, no registration. Use the SAME referrer for the quote and the swap so they cannot diverge. Check and claim accruals with `get_referrer_balance`.

## Workflow

1. **Discover**: `get_coins` (`sort=new` for latest launches, `q` to search). `get_coin` for one coin's price, market cap, 24h stats, and fair launch state. `get_candles` for trend.
2. **Quote**: `quote_swap { coin, side: "buy"|"sell", amount, referrer }`. Buys spend USDC, sells spend the coin.
3. **Execute**: `prepare_swap { coin, side, amount, slippageBps?, referrer }` returns two unsigned steps: an ERC20 approve of the input token to the PoolSwap router, then the swap. Simulate each, then sign and send in order with your wallet tooling. Default slippage is 500 bps; tighten for large pools.
4. **Verify**: the swap appears in `get_coin`'s 24h stats and the coin's activity within seconds.

## Holder income

Holding coins earns a share of the daily USDC pool (24% of every fee). `get_holder_rewards { address }` returns the entitlement, what is already claimed, and the unsigned claim transaction when something is claimable.

## Failure modes

- "Pool has no observed price yet": the coin has never traded; quote first or wait for a trade.
- During a coin's fair launch window, fills happen at the fixed launch price; quotes still work.
- Rate limited per IP; back off on 429.
