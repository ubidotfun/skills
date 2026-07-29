---
name: ubi
description: Route to the right ubi.fun skill. ubi.fun is a memecoin launchpad on Arc mainnet (chain 5042, USDC gas) where creators keep up to 56% of every swap fee, 24% funds a daily USDC pool for all holders, and whoever routes a swap earns 5% of its fee on-chain.
---

# ubi.fun

Umbrella skill. Pick the deeper skill that matches the job:

- **Trade coins, quote prices, discover markets, earn the 5% referrer share** → `ubi-trading`
- **Launch a coin (image, metadata, one transaction)** → `ubi-launch`

## Facts that apply everywhere

- Chain: Arc mainnet, chain id `5042`. Gas is USDC. Cash side of every pool is USDC (6 decimals); coins have 18 decimals and a fixed 100 billion supply.
- MCP server: `https://api.ubi.fun/mcp` (Streamable HTTP, no API key). Connect with:
  - Claude Code: `claude mcp add --transport http ubi https://api.ubi.fun/mcp`
  - Generic config: `{ "mcpServers": { "ubi": { "type": "http", "url": "https://api.ubi.fun/mcp" } } }`
- Trust model: the MCP never requests, stores, or uses wallet keys, and never sends transactions. Tools named `prepare_*` return unsigned `{ chainId, to, data, value }` steps; simulate, sign, and send them with your own wallet tooling.
- Fee split, fixed in bytecode: 5% referrer, 15% team, 24% holder pool, 56% creator.
- Deeper references: REST API and contracts at https://ubi.fun/docs/integrate (all pages have `.md` versions).
