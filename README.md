# ubi.fun AI skills

Skill files that teach AI coding agents to trade and launch on [ubi.fun](https://ubi.fun), the token launchpad on Arc mainnet where tokens launched with a creator vault (all since October 4, 2026) pay their holders USDC (v3 tokens pay in their pair asset, gold today), the platform's fees pay daily USDC to $UBI holders, and routing a swap earns the router 5% of its fee on-chain.

Install all four skills; the umbrella `ubi` skill routes the agent to the right deeper one:

```bash
npx skills add ubidotfun/skills --skill '*'
```

Then prompt the agent plainly, e.g. "Use ubi: buy $25 of the top new token and set me as referrer."

| Skill | What it covers |
| --- | --- |
| `ubi` | Chain facts, MCP connection, trust model, fees, routing |
| `ubi-trading` | Discover, quote, swap, referrer earnings, holder income, dividends and creator earnings |
| `ubi-launch` | Metadata upload and one-transaction launches with a creator vault |
| `ubi-circle` | Send the prepared steps from a Circle Agent Wallet on Arc, so the agent trades, launches and claims itself |

The skills drive the hosted MCP server at `https://api.ubi.fun/mcp` (Streamable HTTP, no API key). It never requests or uses wallet keys: `prepare_*` tools return unsigned calldata for the agent's own wallet tooling; `ubi-circle` is one such tool, for Circle Agent Wallets (one-time setup in your own terminal, see its SKILL.md). Full integrator docs: https://ubi.fun/docs/integrate/overview
