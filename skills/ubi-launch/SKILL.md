---
name: ubi-launch
description: Launch a memecoin on ubi.fun (Arc mainnet) through the ubi MCP server in one transaction. The creator keeps the revenue NFT and 56% of every swap fee.
---

# Launch a coin on ubi.fun

Connect the MCP server first (see the `ubi` skill). Launching is two tool calls plus one signed transaction. The default $10,000 market cap launch is currently fee-free; larger market caps can require a fee, which prepare_launch computes into the value field for you.

## Workflow

1. **Metadata**: `upload_token_metadata { imageUrl | imageBase64, name, description?, website? }` pins the image and metadata and returns `{ tokenUri, image }`. Images up to 5MB.
2. **Prepare**: `prepare_launch { name, symbol, tokenUri, creator }` returns the unsigned FlaunchZap transaction. `creator` receives the revenue NFT (the claim on 56% of every swap fee) and can withdraw earnings any time. Defaults mirror the ubi.fun app: $10,000 initial market cap, 90/10 creator/floor-bid split, no fair launch. Options: `marketCapUsd` (min 10000; larger caps can require a fee, returned in `value`), `creatorFeePercent`, `fairLaunchPercent` + `fairLaunchMinutes` (anti-sniper: that share of supply sells at a fixed price for the window), `startAtUnix` for a scheduled launch (at most 30 days out).
3. **Send**: simulate the step first; the simulated return value is the new coin's address. Sign and send with your wallet tooling, including the exact `value` from the prepared step (0 for the default market cap). Gas is USDC.
4. **Verify**: the coin appears in `get_coins` within seconds of confirmation.

## Notes

- Supply is fixed at 100 billion; liquidity is locked in the Uniswap v4 pool at creation.
- A scheduled launch (`startAtUnix` in the future) is not tradeable until that time.
- Premine is not exposed through the MCP; use the app or raw contracts if you need it.
