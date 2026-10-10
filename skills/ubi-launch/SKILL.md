---
name: ubi-launch
description: Launch a token on ubi.fun (Arc mainnet) through the ubi MCP server in one transaction, with a creator vault that pays the creator and the token's holders in USDC. Use when the user wants to create, deploy, or launch a token or memecoin on ubi.fun or Arc.
---

# Launch a token on ubi.fun

Connect the MCP server first (see the `ubi` skill). Launching is two tool calls plus one signed transaction. The default $10,000 market cap launch is currently fee-free; larger market caps can require a fee, which `prepare_launch` computes into the `value` field for you.

## Workflow

1. **Metadata**: `upload_token_metadata { imageUrl | imageBase64 | imageCid, name, symbol, description, website?, twitter?, telegram?, discord? }` pins the image and metadata and returns `{ tokenUri, image, imageCid }`. Images up to 5MB. Pass `imageCid` from a previous upload to reuse the image when only the metadata changes. Social links surface on the market APIs and the token's page.
2. **Prepare**: `prepare_launch { name, symbol, tokenUri, creator }` returns the unsigned FlaunchZap transaction plus the vault settings it encodes. Defaults mirror the ubi.fun app. Options:
   - `feePercent`: trading fee, 1.5 to 5 (default 1.5).
   - `holderSharePercent`: share of the creator's earnings paid to the token's holders, 16.67 to 100 (default 16.67).
   - `buybackPercent`: share of the creator side that buys the token back and burns it, 0 to 10 (default 10).
   - `recipients`: up to 4 `{ address, percent }` rows sharing what the creator keeps after holder dividends; the creator keeps the rest.
   - `marketCapUsd` (min 10000; larger caps can require a fee, returned in `value`), `fairLaunchPercent` + `fairLaunchMinutes` (anti-sniper: that share of supply sells at a fixed price for the window), `startAtUnix` for a scheduled launch (at most 30 days out).
3. **Send**: simulate the step first; the simulated return value is the new token's address. Sign and send with your wallet tooling, including the exact `value` from the prepared step (0 for the default market cap). Gas is USDC.
4. **Verify**: the token appears in `get_coins` within seconds of confirmation.

## What the creator gets

- The launch creates a creator vault. The revenue NFT goes into it and stays there for good. The vault receives the creator side of every fee and splits it between `creator` (plus any `recipients`) and the token's holders, at the shares above.
- The creator and recipients claim their USDC on the token's page at ubi.fun, whenever they like.
- Fee, holder share, buyback and recipients are permanent. The only later change is the creator renouncing, which sends every future creator fee to holders.

## Notes

- Supply is fixed at 100 billion; liquidity is locked in the Uniswap v4 pool at creation.
- A scheduled launch (`startAtUnix` in the future) is not tradeable until that time.
- Premine is not supported on Arc (a premine launch reverts). To hold the token from the start, launch, then buy with `prepare_swap` from the `ubi-trading` skill.
- Every launch must have a creator vault: a token launched without one can never trade. `prepare_launch` always builds the vault and refuses to prepare a launch if the vault contracts are not active on-chain. Don't hand-build launch calldata.
