# ubi.fun AI skills

Skill files that teach AI coding agents to trade and launch on [ubi.fun](https://ubi.fun), the memecoin launchpad on Arc mainnet where creators keep up to 56% of every swap fee, 24% funds a daily USDC pool for all holders, and routing a swap earns the router 5% of its fee on-chain.

Install the umbrella skill and it routes the agent to the right deeper skill:

```bash
npx skills add https://github.com/ubidotfun/skills --skill ubi
```

Then prompt the agent plainly, e.g. "Use ubi: buy $25 of the top new coin and set me as referrer."

| Skill | What it covers |
| --- | --- |
| `ubi` | Chain facts, MCP connection, trust model, routing |
| `ubi-trading` | Discover, quote, swap, referrer earnings, holder income |
| `ubi-launch` | Metadata upload and one-transaction launches |

The skills drive the hosted MCP server at `https://api.ubi.fun/mcp` (Streamable HTTP, no API key). It never requests or uses wallet keys: `prepare_*` tools return unsigned calldata for the agent's own wallet tooling. Full integrator docs: https://ubi.fun/docs/integrate.
