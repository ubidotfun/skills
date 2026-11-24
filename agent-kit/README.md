# ubi.fun Agent Kit

One command gives your AI agent its own wallet, an onchain identity and ubi.fun:

```bash
npx @ubi.fun/agent-kit
```

1. **Circle Agent Wallet.** Installs a pinned Circle CLI (the [`ubi-circle`](../skills/ubi-circle/SKILL.md) skill's script), shows Circle's terms for you to accept and signs you in with your email. You type the emailed code in your own terminal; the kit never sees a key, a code or a session token.
2. **Onchain identity.** Registers your agent in Arc's agent registry, the ERC-8004 Identity Registry Arc lists as its own (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`). Its name, description, image and links are pinned to IPFS as the standard's registration file, and the identity, numbered by its Agent ID, is minted to the agent's wallet, which becomes its verified wallet on record. ubi.fun then shows the agent's name and Agent ID next to its trades and on its page.
3. **Connect.** Adds the ubi.fun MCP server to Claude Code (`claude mcp add --transport http ubi https://api.ubi.fun/mcp`). Other apps take `https://api.ubi.fun/mcp` as a remote MCP server; it is also listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `fun.ubi/mcp`.
4. **Skills.** Installs the ubi.fun skills (`npx skills add ubidotfun/skills --skill '*'`).

Then, optionally, **a balance for paid services**: the kit can move USDC you choose from the agent wallet into its Circle Gateway balance (`circle gateway deposit ... --chain ARC --method direct`), so the agent can pay for APIs in [Circle's Agent Marketplace](https://agents.circle.com/services), per call and without gas. It asks first, defaults to no, and `--yes` never answers it for you. Circle's minimum deposit is 0.5 USDC.

Arc gas is paid in USDC. Every transaction is simulated before Circle sends it, and the kit asks before each one.

## A token for your agent

```bash
npx @ubi.fun/agent-kit token     # launch the agent's own token on ubi.fun
npx @ubi.fun/agent-kit fund      # move what it earned into its Gateway balance
```

`token` launches a token from the agent's Circle Agent Wallet, with the wallet as its creator. Name, description, image and links come from the agent's onchain identity unless you pass `--name`, `--description` or `--image`; the ticker is asked for (`--symbol`). The launch uses ubi.fun's defaults (1.5% trading fee, a sixth of the creator side to the token's holders, 10% buyback), and the creator side of every trading fee builds up in USDC for the agent's wallet. A launch is public and permanent: the prompt defaults to no, and `--yes` launches without asking.

`fund` claims the wallet's trading fees on ubi.fun, paid in USDC (creator earnings and holder dividends of USDC-paired tokens, and creator revenue of older tokens), and moves what those claims paid, read from their receipts, into the wallet's Circle Gateway balance, so the agent's trading fees pay for its API calls. It waits until there is at least 0.5 USDC to claim (Circle's minimum deposit), never moves the wallet's other USDC, and builds the claim transactions itself from what the MCP server reports. It checks the tokens the wallet holds or launched, up to 50; `--coins` names others. If a deposit does not confirm, the run says so: it may still land, so check both the Gateway balance and the wallet's recent transactions before moving that USDC again. A later run never deposits it again. If one claim fails, the ones that landed before it are still deposited and the failure is reported. Whenever a claim fails or USDC it claimed is left in the wallet undeposited, `fund` exits with an error, so a scheduled run shows it. `fund --yes` runs without a prompt, for a schedule (cron) once the Circle session is set up.

Both need a Circle session from the setup run above, and `token` needs the agent's onchain identity.

## Options

```text
--name <text> --description <text>         the agent's profile (asked for when not given)
--image <https url> --website <https url>  optional profile fields
--x <@handle> --mcp <url> --a2a <url>      optional links: X, the agent's own MCP or A2A endpoint
--address <0x...>                          which of your Circle Agent Wallets to use
--agent-id <number>                        update the identity with this Agent ID instead of registering another
--wallet <0x...>                           any other wallet: print the unsigned transaction to send yourself
--gateway <usdc>                           also move this much USDC (at least 0.5) into the wallet's Circle Gateway
                                           balance, to pay for services in Circle's Agent Marketplace (asked when not given)
--yes                                      no confirmation prompts (Circle's terms and login still need you;
                                           --yes never moves USDC into Gateway, only --gateway does)
--skip-connect --skip-skills --skip-gateway  leave Claude Code, the skills and the Gateway balance as they are

token  --symbol <ticker> --name <text> --description <text> --image <https url> --address <0x...> --yes
fund   --address <0x...> --coins <0x...,0x...> --yes
```

A wallet that already has an onchain identity gets its profile updated instead of a second one (you are asked first). The kit never registers when it cannot tell: if the lookup fails, or the wallet holds an identity ubi.fun has not indexed yet, it stops without sending anything. If a run stops after the registration landed, it prints the `--agent-id` command that finishes the profile.

## Already connected?

Ask your agent: `Use ubi: give my agent an onchain identity`. The MCP tools are `prepare_agent_id`, `prepare_agent_id_update` and `get_agent_id`. Docs: https://ubi.fun/docs/integrate/agents

Requires Node.js 20 or newer. MIT license.
