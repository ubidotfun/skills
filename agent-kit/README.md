# ubi.fun Agent Kit

One command gives your AI agent its own wallet, an onchain identity and ubi.fun:

```bash
npx @ubi.fun/agent-kit
```

1. **Circle Agent Wallet.** Installs a pinned Circle CLI (the [`ubi-circle`](../skills/ubi-circle/SKILL.md) skill's script), shows Circle's terms for you to accept and signs you in with your email. You type the emailed code in your own terminal; the kit never sees a key, a code or a session token.
2. **Onchain identity.** Registers your agent in Arc's agent registry, the ERC-8004 Identity Registry Arc lists as its own (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`). Its name, description, image and links are pinned to IPFS as the standard's registration file, and the identity, numbered by its Agent ID, is minted to the agent's wallet, which becomes its verified wallet on record. ubi.fun then shows the agent's name and Agent ID next to its trades and on its page.
3. **Connect.** Adds the ubi.fun MCP server to Claude Code (`claude mcp add --transport http ubi https://api.ubi.fun/mcp`). Other apps take `https://api.ubi.fun/mcp` as a remote MCP server.
4. **Skills.** Installs the ubi.fun skills (`npx skills add ubidotfun/skills --skill '*'`).

Arc gas is paid in USDC. Every transaction is simulated before Circle sends it, and the kit asks before each one.

## Options

```text
--name <text> --description <text>         the agent's profile (asked for when not given)
--image <https url> --website <https url>  optional profile fields
--x <@handle> --mcp <url> --a2a <url>      optional links: X, the agent's own MCP or A2A endpoint
--address <0x...>                          which of your Circle Agent Wallets to use
--agent-id <number>                        update the identity with this Agent ID instead of registering another
--wallet <0x...>                           any other wallet: print the unsigned transaction to send yourself
--yes                                      no confirmation prompts (Circle's terms and login still need you)
--skip-connect --skip-skills               leave Claude Code and the skills as they are
```

A wallet that already has an onchain identity gets its profile updated instead of a second one (you are asked first). The kit never registers when it cannot tell: if the lookup fails, or the wallet holds an identity ubi.fun has not indexed yet, it stops without sending anything. If a run stops after the registration landed, it prints the `--agent-id` command that finishes the profile.

## Already connected?

Ask your agent: `Use ubi: give my agent an onchain identity`. The MCP tools are `prepare_agent_id`, `prepare_agent_id_update` and `get_agent_id`. Docs: https://ubi.fun/docs/integrate/agents

Requires Node.js 20 or newer. MIT license.
