// ubi.fun Agent Kit: a Circle Agent Wallet, an onchain identity in Arc's agent registry (ERC-8004) and the
// ubi.fun MCP server for your agent, in one run.
//
// Trust model, same as the ubi.fun MCP server and the ubi-circle skill: no key, email code or
// session token passes through this kit. Circle's CLI signs and submits (lib/ubi-circle.mjs, a
// byte-for-byte copy of skills/ubi-circle/scripts/ubi-circle.mjs); you accept Circle's terms and
// type the emailed code in your own terminal; the MCP server only prepares unsigned transactions.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

export const MCP_URL = process.env.UBI_MCP_URL ?? 'https://api.ubi.fun/mcp'
export const RPC_URL = process.env.UBI_CIRCLE_RPC_URL ?? 'https://rpc.mainnet.arc.io'
export const SITE = 'https://ubi.fun'
/** Arc's ERC-8004 Identity Registry (docs.arc.io contract addresses). */
export const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = `0x${'0'.repeat(64)}`
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const UBI_CIRCLE = join(dirname(fileURLToPath(import.meta.url)), 'ubi-circle.mjs')
export const CLAUDE_MCP_ADD = ['mcp', 'add', '--transport', 'http', 'ubi', 'https://api.ubi.fun/mcp']
export const SKILLS_ADD = ['--yes', 'skills', 'add', 'ubidotfun/skills', '--skill', '*']

export class KitError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// --- arguments -----------------------------------------------------------------------------------

const VALUE_FLAGS = { '--name': 'name', '--description': 'description', '--image': 'image', '--website': 'website', '--x': 'x', '--mcp': 'mcp', '--a2a': 'a2a', '--address': 'address', '--wallet': 'wallet', '--agent-id': 'agentId', '--gateway': 'gateway', '--symbol': 'symbol', '--coins': 'coins' }
const BOOL_FLAGS = { '--yes': 'yes', '-y': 'yes', '--skip-connect': 'skipConnect', '--skip-skills': 'skipSkills', '--skip-gateway': 'skipGateway', '--help': 'help', '-h': 'help' }
/** `token` launches the agent's own token, `fund` moves what the agent earned into its Gateway balance. */
export const COMMANDS = ['token', 'fund']
/** The options each run takes; `setup` is the run without a command. */
const COMMAND_FLAGS = {
  setup: ['name', 'description', 'image', 'website', 'x', 'mcp', 'a2a', 'address', 'wallet', 'agentId', 'gateway', 'yes', 'skipConnect', 'skipSkills', 'skipGateway', 'help'],
  token: ['name', 'symbol', 'description', 'image', 'address', 'yes', 'help'],
  fund: ['address', 'coins', 'yes', 'help'],
}
const FLAG_OF = Object.fromEntries([...Object.entries(VALUE_FLAGS), ...Object.entries(BOOL_FLAGS)].map(([flag, key]) => [key, flag]))
/** The most the kit deposits into a Gateway balance in one run; more goes through the Circle CLI directly. */
export const GATEWAY_MAX_USDC = 1000
/** Circle CLI 1.2.2 refuses a Gateway deposit below 0.5 USDC (MIN_GATEWAY_DEPOSIT_USDC). */
export const GATEWAY_MIN_USDC = 0.5
const GATEWAY_MIN_UNITS = 500_000n

/** A deposit amount in USDC: up to 6 decimals, at least GATEWAY_MIN_USDC, at most GATEWAY_MAX_USDC. */
export function gatewayAmount(value) {
  const text = String(value).trim()
  if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) < GATEWAY_MIN_USDC) throw new KitError('BAD_ARGUMENT', `--gateway must be a USDC amount of at least ${GATEWAY_MIN_USDC} (Circle's minimum deposit), like 1`)
  if (Number(text) > GATEWAY_MAX_USDC) throw new KitError('BAD_ARGUMENT', `--gateway is capped at ${GATEWAY_MAX_USDC} USDC here; deposit more with the Circle CLI`)
  return text
}

/** Circle CLI 1.2.2: moves USDC from the agent wallet into its Gateway balance on Arc. */
export function gatewayDepositArgs(amount, wallet) {
  return ['circle', 'gateway', 'deposit', '--amount', amount, '--address', wallet, '--chain', 'ARC', '--method', 'direct']
}

export function parseArgs(argv) {
  const args = {}
  let start = 0
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    if (!COMMANDS.includes(argv[0])) throw new KitError('BAD_ARGUMENT', `Unknown command ${argv[0]}. Run with --help.`)
    args.command = argv[0]
    start = 1
  }
  for (let i = start; i < argv.length; i++) {
    const flag = argv[i]
    if (flag in VALUE_FLAGS) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new KitError('BAD_ARGUMENT', `${flag} needs a value`)
      args[VALUE_FLAGS[flag]] = value
    } else if (flag in BOOL_FLAGS) {
      args[BOOL_FLAGS[flag]] = true
    } else {
      throw new KitError('BAD_ARGUMENT', `Unknown option ${flag}. Run with --help.`)
    }
  }
  const allowed = COMMAND_FLAGS[args.command ?? 'setup']
  for (const key of Object.keys(args)) {
    if (key !== 'command' && !allowed.includes(key)) {
      throw new KitError('BAD_ARGUMENT', `${FLAG_OF[key]} does not work with ${args.command ? `the ${args.command} command` : 'the setup run'}. Run with --help.`)
    }
  }
  for (const key of ['address', 'wallet']) {
    if (args[key] !== undefined && !ADDRESS.test(args[key])) throw new KitError('BAD_ARGUMENT', `--${key} must be a 0x address`)
  }
  if (args.coins !== undefined) {
    const coins = args.coins.split(',').map((coin) => coin.trim()).filter(Boolean)
    if (coins.length === 0 || coins.length > 50 || !coins.every((coin) => ADDRESS.test(coin))) throw new KitError('BAD_ARGUMENT', '--coins takes 1 to 50 token addresses, comma-separated')
    args.coins = coins
  }
  if (args.agentId !== undefined && !/^\d{1,30}$/.test(args.agentId)) throw new KitError('BAD_ARGUMENT', '--agent-id must be a number')
  if (args.agentId !== undefined && args.wallet) throw new KitError('BAD_ARGUMENT', '--agent-id works with a Circle Agent Wallet, not with --wallet')
  if (args.gateway !== undefined) {
    args.gateway = gatewayAmount(args.gateway)
    if (args.wallet) throw new KitError('BAD_ARGUMENT', '--gateway works with a Circle Agent Wallet, not with --wallet')
    if (args.skipGateway) throw new KitError('BAD_ARGUMENT', 'Use --gateway or --skip-gateway, not both')
  }
  return args
}

export const HELP = `ubi.fun Agent Kit: give your AI agent a Circle Agent Wallet, an onchain identity on Arc and ubi.fun

  npx @ubi.fun/agent-kit                     interactive: wallet, identity, connect, skills

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

  npx @ubi.fun/agent-kit token               launch the agent's own token on ubi.fun, from its Circle Agent Wallet
    --symbol <ticker>                        the ticker (asked for when not given)
    --name <text> --description <text>       default: the agent's name and description from its identity
    --image <https url>                      default: the agent's profile image
    --address <0x...> --yes                  which wallet; no confirmation prompt
                                             The wallet is the token's creator: its share of every trading fee
                                             builds up in USDC for it to collect.

  npx @ubi.fun/agent-kit fund                collect the agent's trading fees on ubi.fun (paid in USDC) and move
                                             what the claims paid into its Circle Gateway balance, for API calls
    --address <0x...> --yes                  which wallet; --yes collects and deposits with no prompt (for a
                                             scheduled run). It waits until there is at least ${GATEWAY_MIN_USDC} USDC
                                             (Circle's minimum deposit) and never moves the wallet's other USDC.
    --coins <0x...,0x...>                    check these tokens (up to 50) instead of the ones it holds or launched

The identity is an ERC-8004 token in Arc's Identity Registry (${REGISTRY}), numbered by its Agent ID.
ubi.fun shows the agent's name and Agent ID next to its trades. Docs: ${SITE}/docs/integrate/agents
`

// --- small helpers -------------------------------------------------------------------------------

/** One MCP tool call over Streamable HTTP (the server is stateless: no session needed). */
export async function callTool(name, args, { fetchImpl = fetch, url = MCP_URL } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) throw new KitError('MCP_UNAVAILABLE', `ubi.fun MCP answered HTTP ${response.status}`)
  const payload = await response.json()
  const text = payload?.result?.content?.[0]?.text
  if (payload?.error) throw new KitError('MCP_ERROR', payload.error.message ?? 'MCP error')
  if (typeof text !== 'string') throw new KitError('MCP_ERROR', `${name} returned nothing`)
  if (payload.result.isError) throw new KitError('MCP_TOOL_ERROR', text.replace(/^MCP error -?\d+: /, ''))
  return JSON.parse(text)
}

/** The Agent ID minted to `wallet` in a receipt: the registry's Transfer from the zero address. */
export function agentIdFromLogs(logs, wallet) {
  for (const log of logs ?? []) {
    if (String(log.address).toLowerCase() !== REGISTRY.toLowerCase()) continue
    const [topic0, from, to, id] = log.topics ?? []
    if (topic0 !== TRANSFER_TOPIC || from !== ZERO_TOPIC || !to || !id) continue
    if (BigInt(to) !== BigInt(wallet)) continue
    return BigInt(id).toString()
  }
  return null
}

/** How many Agent IDs `wallet` owns (the registry's ERC-721 balanceOf), read on chain. */
/** Arc's USDC through its ERC-20 interface (6 decimals). */
export const ARC_USDC = '0x3600000000000000000000000000000000000000'

/** The wallet's USDC on Arc in 6-decimal units, or null when the RPC cannot say. */
export async function usdcBalance(wallet, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: ARC_USDC, data: `0x70a08231${wallet.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await response.json().catch(() => null)
    return typeof payload?.result === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(payload.result) ? BigInt(payload.result) : null
  } catch {
    return null
  }
}

export async function agentIdsHeld(wallet, fetchImpl = fetch) {
  const response = await fetchImpl(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: REGISTRY, data: `0x70a08231${wallet.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'],
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await response.json().catch(() => null)
  if (typeof payload?.result !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(payload.result)) {
    throw new KitError('RPC_UNAVAILABLE', 'Could not read the registry on Arc. Nothing was sent; run again shortly.')
  }
  return BigInt(payload.result)
}

async function receiptOf(hash, fetchImpl = fetch) {
  const response = await fetchImpl(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await response.json()
  return payload?.result ?? null
}

/** An X handle or x.com link as the handle the MCP takes; undefined when it is neither. */
export function normalizeX(value) {
  const match = /^@?([A-Za-z0-9_]{1,15})$/.exec(value.trim()) ?? /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i.exec(value.trim())
  return match ? `@${match[1]}` : undefined
}

/** The prepare_agent_id arguments from the answers; only fields that were given. */
export function profileArgs(answers) {
  const out = { name: answers.name.trim(), description: answers.description.trim() }
  if (answers.image) out.imageUrl = answers.image.trim()
  if (answers.website) out.website = answers.website.trim()
  if (answers.x) {
    const x = normalizeX(answers.x)
    if (!x) throw new KitError('BAD_ARGUMENT', 'X must be a handle like @name or an x.com link')
    out.x = x
  }
  if (answers.mcp) out.mcp = answers.mcp.trim()
  if (answers.a2a) out.a2a = answers.a2a.trim()
  return out
}

/** Runs lib/ubi-circle.mjs; `inherit` hands the terminal over (terms, login). */
function ubiCircle(args, { inherit = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UBI_CIRCLE, ...args], { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => {
      let json = null
      try {
        json = JSON.parse(stdout)
      } catch {
        // interactive or non-JSON output
      }
      resolve({ code, json, stdout, stderr })
    })
  })
}

function run(command, args, { inherit = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let output = ''
    child.stdout?.on('data', (chunk) => (output += chunk))
    child.stderr?.on('data', (chunk) => (output += chunk))
    child.on('error', () => resolve({ code: 127, output }))
    child.on('close', (code) => resolve({ code, output }))
  })
}

async function onPath(command) {
  const probe = process.platform === 'win32' ? await run('where', [command], { inherit: false }) : await run('sh', ['-c', `command -v ${command}`], { inherit: false })
  return probe.code === 0
}

// --- the run -------------------------------------------------------------------------------------

export async function main(argv, io = { stdin: process.stdin, stdout: process.stdout }) {
  const args = parseArgs(argv)
  if (args.help) {
    io.stdout.write(HELP)
    return
  }
  const say = (line = '') => io.stdout.write(`${line}\n`)
  const interactive = Boolean(io.stdin.isTTY)
  let rl = interactive ? createInterface({ input: io.stdin, output: io.stdout }) : null
  // A child that takes the terminal (Circle's terms and login, the skills installer) must be its only
  // reader: the kit's own prompt is closed first, so no keystroke, and never the emailed code, reaches it
  const handOver = async (fn) => {
    rl?.close()
    rl = null
    try {
      return await fn()
    } finally {
      if (interactive) rl = createInterface({ input: io.stdin, output: io.stdout })
    }
  }
  const ask = async (question, fallback) => {
    if (!rl) return fallback
    const answer = (await rl.question(question)).trim()
    return answer || fallback
  }
  const confirm = async (question, byDefault = true) => {
    if (args.yes) return true
    if (!rl) return byDefault
    const answer = (await rl.question(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
    return answer ? answer.startsWith('y') : byDefault
  }

  try {
    const [major] = process.versions.node.split('.').map(Number)
    if (major < 20) throw new KitError('NODE_TOO_OLD', `Node.js 20 or newer is needed (this is ${process.versions.node})`)
    if (args.command) {
      const ctx = { say, ask, confirm, handOver, interactive }
      await (args.command === 'token' ? launchAgentToken : fundGateway)(args, ctx)
      return
    }
    say('ubi.fun Agent Kit')
    say(`Agent IDs live in Arc's agent registry (ERC-8004, ${REGISTRY}).`)
    say()

    // 1. Profile first: nothing is installed or signed before the user has said who the agent is
    const answers = {
      name: args.name ?? (await ask('Agent name: ', undefined)),
      description: args.description ?? (await ask('What does it do? (one or two sentences): ', undefined)),
      image: args.image ?? (await ask('Image URL (https, optional): ', undefined)),
      website: args.website ?? (await ask('Website (https, optional): ', undefined)),
      x: args.x ?? (await ask('X handle (optional): ', undefined)),
      mcp: args.mcp,
      a2a: args.a2a,
    }
    if (!answers.name || !answers.description) {
      throw new KitError('BAD_ARGUMENT', 'An Agent ID needs a name and a description (--name, --description)')
    }
    const profile = profileArgs(answers)

    // Any wallet: print the unsigned transaction and stop
    if (args.wallet) {
      const prepared = await callTool('prepare_agent_id', { wallet: args.wallet, ...profile })
      say('Send this transaction from your wallet (it was simulated from it). Then ask your agent:')
      say(`  Use ubi: run prepare_agent_id_update for my new Agent ID from ${args.wallet}`)
      say()
      say(JSON.stringify(prepared.steps, null, 2))
      return
    }

    // 2. Circle Agent Wallet: the pinned CLI, then the user's own terms and login if needed
    say('Step 1 of 4: Circle Agent Wallet')
    const setup = await ubiCircle(['setup'])
    if (setup.code !== 0 || !setup.json?.ok) throw new KitError(setup.json?.code ?? 'SETUP_FAILED', setup.json?.message ?? 'Installing the Circle CLI failed (npm is needed)')
    let wallets = await ubiCircle(['wallets'])
    if (!wallets.json?.ok) {
      if (!interactive) {
        throw new KitError('NEEDS_YOU', 'No Circle session. Run this kit in your own terminal: Circle terms and the emailed code are yours to answer.')
      }
      say("Circle's terms come first. Read them here:")
      await handOver(() => ubiCircle(['circle', 'terms', 'show'], { inherit: true }))
      // The human answers this in their own terminal; --yes never accepts terms for them
      const accepted = (await rl.question("Do you accept Circle's terms? [y/N] ")).trim().toLowerCase().startsWith('y')
      if (!accepted) throw new KitError('TERMS_DECLINED', "Circle's terms were not accepted. Nothing was set up.")
      await handOver(() => ubiCircle(['circle', 'terms', 'accept'], { inherit: true }))
      const email = (await rl.question('Email for your Circle Agent Wallet: ')).trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new KitError('BAD_ARGUMENT', 'That is not an email address')
      say("Circle emails you a code. Circle's own prompt asks for it next (type it only there, never in a chat).")
      const login = await handOver(() => ubiCircle(['circle', 'wallet', 'login', email, '--type', 'agent'], { inherit: true }))
      if (login.code !== 0) throw new KitError('LOGIN_FAILED', 'Circle login did not finish')
      wallets = await ubiCircle(['wallets'])
      if (!wallets.json?.ok) throw new KitError('CIRCLE_NOT_READY', 'Still no Circle session after login')
    }
    const wallet = await pickWallet(wallets.json.wallets ?? [], args, { say, ask, interactive: Boolean(rl) })
    say(`  Agent wallet on Arc: ${wallet}`)
    say()

    // 3. Agent ID: register (or update the one this wallet already has), then name the ID in its profile
    say('Step 2 of 4: Agent ID')
    let agentId = args.agentId ?? null
    let registeredNow = false
    // The update always carries the whole profile, so it never depends on reading the new file back
    let updateProfile = profile
    let register = !agentId
    if (!agentId) {
      // Never mint a second ID by accident: an unanswered lookup stops the run, and so does an ID the
      // wallet holds that the index cannot name yet
      let existing
      try {
        existing = await callTool('get_agent_id', { wallet })
      } catch (error) {
        throw new KitError('LOOKUP_FAILED', `Could not check whether ${wallet} already has an Agent ID (${error.message}). Nothing was sent; run again shortly.`)
      }
      const held = await agentIdsHeld(wallet)
      agentId = existing?.primary?.agentId ?? null
      if (agentId) {
        // Only an explicit "n" at the prompt registers another; --yes updates
        register = !(await confirm(`This wallet already has Agent ID #${agentId}. Update its profile instead of registering another?`))
      } else if (held > 0n) {
        const why = existing?.index?.complete === false ? "ubi.fun's index of the registry is still catching up" : 'none of them names it as its verified wallet'
        if (args.yes || !interactive || !(await confirm(`This wallet already holds ${held} Agent ID(s), but ${why}. Register another anyway?`, false))) {
          throw new KitError('ALREADY_HOLDS_ID', `${wallet} already holds ${held} Agent ID(s). Run again with --agent-id <number> to update one, or later once ubi.fun has indexed it. Nothing was sent.`)
        }
      }
    }
    if (!register) {
      say(`  Updating Agent ID #${agentId}`)
    } else {
      const prepared = await callTool('prepare_agent_id', { wallet, ...profile })
      say(`  Profile pinned: ${prepared.agentURI}`)
      // The image is pinned once: the update reuses its CID
      const { imageUrl: _pinned, ...rest } = profile
      const imageCid = /^ipfs:\/\/(\w+)$/.exec(prepared.registrationFile?.image ?? '')?.[1]
      updateProfile = { ...rest, ...(imageCid ? { imageCid } : {}) }
      if (!(await confirm(`Register "${profile.name}" from ${wallet}? Arc gas is paid in USDC.`))) throw new KitError('CANCELLED', 'Nothing was sent')
      const sent = await sendSteps(wallet, prepared)
      const receipt = await receiptOf(sent.txHash).catch(() => null)
      agentId = receipt ? agentIdFromLogs(receipt.logs, wallet) : null
      if (!agentId) {
        throw new KitError('ID_UNKNOWN', `Registered (${sent.explorer}), but the new ID could not be read from the receipt yet. Find it on that page, then finish with: npx @ubi.fun/agent-kit --agent-id <number> --address ${wallet}`)
      }
      registeredNow = true
      say(`  Registered: Agent ID #${agentId} (${sent.explorer})`)
    }
    // The standard asks the profile to name its own ID; an existing ID takes the new profile here too
    try {
      const update = await callTool('prepare_agent_id_update', { agentId, wallet, ...updateProfile })
      const updated = await sendSteps(wallet, update)
      say(`  Profile ${registeredNow ? 'linked to its ID' : 'updated'} (${updated.explorer})`)
    } catch (error) {
      if (!registeredNow) throw error
      // The ID exists: say so, and how to finish without minting another
      throw new KitError(error.code ?? 'UPDATE_FAILED', `Agent ID #${agentId} is registered, but linking its profile failed: ${error.message}\nFinish with: npx @ubi.fun/agent-kit --agent-id ${agentId} --address ${wallet}`)
    }
    say()

    // 4. Connect the agent and teach it the tools
    say('Step 3 of 4: Connect ubi.fun')
    if (!args.skipConnect && (await onPath('claude')) && (await confirm('Add ubi.fun to Claude Code?'))) {
      const added = await run('claude', CLAUDE_MCP_ADD, { inherit: false })
      say(added.code === 0 || /already exists/i.test(added.output) ? '  Claude Code is connected to ubi.fun' : `  Claude Code said: ${added.output.trim().slice(0, 200)}`)
    } else {
      say('  Other apps: add the MCP server https://api.ubi.fun/mcp (Streamable HTTP, no API key)')
    }
    say()
    say('Step 4 of 4: Skills')
    if (!args.skipSkills && (await confirm('Install the ubi.fun skills for your agent?'))) {
      await handOver(() => run(process.platform === 'win32' ? 'npx.cmd' : 'npx', SKILLS_ADD))
    }
    say()

    // 5. Optional, after the four steps: a Gateway balance, so the agent can pay for x402 services in
    // Circle's Agent Marketplace. It moves the user's USDC, so --yes never answers it: only --gateway
    // <usdc> or an explicit "y" here does.
    say('Optional: a balance for paid services')
    say("  Circle's Agent Marketplace (agents.circle.com/services) lists APIs that charge per call in USDC, paid from the wallet's Circle Gateway balance.")
    const deposit = await chooseGatewayDeposit({ args, rl, wallet, say })
    // The pinned CLI keeps its session in ~/.ubi-circle, so the later route is the ubi-circle skill, not a bare CLI
    const later = 'ask your agent "Use ubi-circle: move 1 USDC into my Gateway balance"'
    if (deposit) {
      const result = await handOver(() => ubiCircle(gatewayDepositArgs(deposit, wallet), { inherit: true }))
      say(result.code === 0 ? `  Moved ${deposit} USDC into the Gateway balance` : `  The deposit did not finish (the wallet needs that much USDC plus a little for gas). Later: ${later}`)
    } else {
      say(`  Skipped. Later: ${later}`)
    }
    say()
    say(`Done. ${profile.name} is Agent ID #${agentId} on Arc.`)
    say(`  Its page: ${SITE}/notes/${wallet.toLowerCase()}`)
    say(`  Fund it with USDC on Arc to trade: ${SITE}/bridge`)
    say('  Try: "Use ubi-circle: buy $5 of $UBI from my Circle wallet"')
  } finally {
    rl?.close()
  }
}

/**
 * How much USDC to move into the Gateway balance, or null for none. Only --gateway or the user's own
 * "y" plus a typed amount says yes (--yes never does). A new wallet is usually still empty here, so
 * the question comes only when the wallet is known to hold Circle's minimum deposit; an unreadable
 * balance asks nothing.
 */
export async function chooseGatewayDeposit({ args, rl, wallet, say, balanceOf = usdcBalance }) {
  if (args.gateway) return args.gateway
  if (args.skipGateway || !rl) return null
  const held = await balanceOf(wallet)
  if (held === null) {
    say("  Couldn't read the wallet's USDC balance on Arc just now.")
    return null
  }
  if (held < GATEWAY_MIN_UNITS) {
    say(`  The wallet holds less than ${GATEWAY_MIN_USDC} USDC on Arc (Circle's minimum deposit); fund it first (see below).`)
    return null
  }
  const wants = (await rl.question('Move USDC from this wallet into its Gateway balance now? [y/N] ')).trim().toLowerCase().startsWith('y')
  if (!wants) return null
  // No default amount: the user types it. The identity is done by now, so an empty or mistyped
  // amount skips this step instead of failing the run.
  try {
    return gatewayAmount((await rl.question(`How much USDC? (at least ${GATEWAY_MIN_USDC}) `)).trim())
  } catch {
    say(`  That is not a USDC amount of at least ${GATEWAY_MIN_USDC} (like 1).`)
    return null
  }
}

/** The Circle Agent Wallet to use: --address, the only one, or the user's pick (default the first). */
export async function pickWallet(list, args, { say, ask, interactive }) {
  if (list.length === 0) throw new KitError('NO_WALLET', 'Your Circle account has no agent wallet on Arc yet')
  if (args.address) {
    const chosen = list.find((w) => w.address.toLowerCase() === args.address.toLowerCase())
    if (!chosen) throw new KitError('WALLET_NOT_FOUND', `${args.address} is not one of your Circle Agent Wallets on Arc`)
    return chosen.address
  }
  if (list.length > 1 && interactive) {
    list.forEach((w, i) => say(`  ${i + 1}. ${w.address}`))
    const pick = Number(await ask(`Which wallet? [1-${list.length}, default 1] `, '1'))
    return list[Math.min(Math.max(Number.isInteger(pick) ? pick : 1, 1), list.length) - 1].address
  }
  return list[0].address
}

/**
 * The commands work from an existing Circle session only: signing in (Circle's terms, the emailed
 * code) is the setup run's job, in the user's own terminal.
 */
async function sessionWallet(args, ctx) {
  const setup = await ubiCircle(['setup'])
  if (setup.code !== 0 || !setup.json?.ok) throw new KitError(setup.json?.code ?? 'SETUP_FAILED', setup.json?.message ?? 'Installing the Circle CLI failed (npm is needed)')
  const wallets = await ubiCircle(['wallets'])
  if (!wallets.json?.ok) {
    throw new KitError('NEEDS_YOU', 'No Circle session. Run npx @ubi.fun/agent-kit in your own terminal first: it signs you in to your Circle Agent Wallet.')
  }
  const wallet = await pickWallet(wallets.json.wallets ?? [], args, ctx)
  ctx.say(`  Agent wallet on Arc: ${wallet}`)
  return wallet
}

// --- token: the agent's own token ----------------------------------------------------------------

/** A ticker: letters and digits, 1 to 32, a leading $ dropped. */
export function tickerOf(value) {
  const text = String(value ?? '').trim().replace(/^\$/, '')
  if (!/^[A-Za-z0-9]{1,32}$/.test(text)) throw new KitError('BAD_ARGUMENT', 'The ticker must be 1 to 32 letters or digits, like OOBIE (--symbol)')
  return text
}

/**
 * The upload_token_metadata arguments for the agent's token: the given fields, else the agent's
 * identity (its name, description, image and its web and X links).
 */
export function tokenMetadataArgs({ name, symbol, description, image }, card = {}) {
  const tokenName = String(name ?? '').trim()
  const about = String(description ?? '').trim()
  if (tokenName.length < 1 || tokenName.length > 64) throw new KitError('BAD_ARGUMENT', 'The token name must be 1 to 64 characters (--name)')
  if (about.length < 1 || about.length > 1000) throw new KitError('BAD_ARGUMENT', 'The description must be 1 to 1000 characters (--description)')
  const out = { name: tokenName, symbol: tickerOf(symbol), description: about }
  const picture = String(image ?? card.image ?? '').trim()
  const cid = /^ipfs:\/\/([a-zA-Z0-9]{46,64})$/.exec(picture)?.[1]
  if (cid) out.imageCid = cid
  else if (/^https:\/\/\S+$/.test(picture)) out.imageUrl = picture
  else throw new KitError('NEEDS_IMAGE', 'The token needs an image: pass --image <https url> (the agent profile has none to reuse)')
  const link = (wanted) => (card.services ?? []).find((s) => String(s?.name).toLowerCase() === wanted && /^https:\/\/\S{1,190}$/.test(String(s?.endpoint ?? '')))?.endpoint
  const website = link('web')
  const twitter = link('x')
  if (website) out.website = website
  if (twitter && /^https:\/\/(x|twitter)\.com\/\w{1,15}\/?$/i.test(twitter)) out.twitter = twitter
  return out
}

/** The new coin's address: the launch step's simulated first return value, or null. */
export async function simulatedCoin(wallet, step, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: wallet, to: step.to, data: step.data, value: `0x${BigInt(step.value ?? '0').toString(16)}` }, 'latest'] }),
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await response.json().catch(() => null)
    const word = typeof payload?.result === 'string' && /^0x[0-9a-fA-F]{64,}$/.test(payload.result) ? payload.result.slice(2, 66) : null
    if (!word || !/^0{24}/.test(word) || /^0{64}$/.test(word)) return null
    return `0x${word.slice(24)}`
  } catch {
    return null
  }
}

async function launchAgentToken(args, ctx) {
  const { say, ask, confirm, interactive } = ctx
  say('ubi.fun Agent Kit: a token for your agent')
  say()
  const wallet = await sessionWallet(args, ctx)
  let found
  try {
    found = await callTool('get_agent_id', { wallet })
  } catch (error) {
    throw new KitError('LOOKUP_FAILED', `Could not read ${wallet}'s Agent ID (${error.message}). Nothing was sent; run again shortly.`)
  }
  const agent = found?.primary
  if (!agent?.agentId) {
    throw new KitError('NO_AGENT_ID', `${wallet} has no Agent ID yet. Give the agent its identity first: npx @ubi.fun/agent-kit --address ${wallet}`)
  }
  const card = agent.card ?? {}
  const agentName = String(card.name ?? agent.name ?? '').trim()
  say(`  Agent ID #${agent.agentId}${agentName ? ` (${agentName})` : ''}`)
  if (!interactive && !args.yes) throw new KitError('NEEDS_YES', 'A launch is public and permanent: run it in a terminal, or pass --yes with --symbol')
  const answers = {
    name: args.name ?? (await ask(`Token name [${agentName}]: `, agentName)),
    symbol: args.symbol ?? (await ask('Ticker (like OOBIE): ', undefined)),
    description: args.description ?? (await ask('Description [the agent profile]: ', card.description)),
    image: args.image,
  }
  const metadata = tokenMetadataArgs(answers, card)
  say('  Pinning the token image and details')
  const pinned = await callTool('upload_token_metadata', metadata)
  if (typeof pinned?.tokenUri !== 'string' || !pinned.tokenUri.startsWith('ipfs://')) throw new KitError('UPLOAD_FAILED', 'Pinning the token details failed. Nothing was sent.')
  const prepared = await callTool('prepare_launch', { name: metadata.name, symbol: metadata.symbol, tokenUri: pinned.tokenUri, creator: wallet })
  const step = prepared?.steps?.at(-1)
  if (!step?.to) throw new KitError('MCP_ERROR', 'prepare_launch returned no transaction. Nothing was sent.')
  const coin = await simulatedCoin(wallet, step)
  const terms = prepared.vault
    ? `${prepared.vault.feePercent}% trading fee. Of the creator side, ${prepared.vault.holderSharePercent}% goes to the token's holders and ${prepared.vault.buybackPercent}% buys it back; the rest builds up in USDC for this wallet.`
    : 'The creator side of every trading fee builds up in USDC for this wallet.'
  // Everything that becomes permanent is shown before the question, including an inherited image
  const imageCid = /^ipfs:\/\/([a-zA-Z0-9]{46,64})$/.exec(String(pinned.image ?? ''))?.[1]
  say(`  Name: ${metadata.name}   Ticker: $${metadata.symbol}`)
  say(`  Description: ${metadata.description.length > 160 ? `${metadata.description.slice(0, 157)}...` : metadata.description}`)
  say(`  Image: ${imageCid ? `https://ipfs.filebase.io/ipfs/${imageCid}` : (metadata.imageUrl ?? pinned.image)}`)
  if (metadata.website || metadata.twitter) say(`  Links: ${[metadata.website, metadata.twitter].filter(Boolean).join('  ')}`)
  say(`  ${terms}`)
  // Public and permanent: only a typed "y" (or --yes) launches
  if (!(await confirm(`Launch ${metadata.name} ($${metadata.symbol}) from ${wallet}? It is public and permanent.`, false))) throw new KitError('CANCELLED', 'Nothing was sent')
  const sent = await sendSteps(wallet, prepared)
  const receipt = coin ? await receiptOf(sent.txHash).catch(() => null) : null
  const confirmed = coin && receipt?.logs?.some((log) => String(log.address).toLowerCase() === coin.toLowerCase())
  say()
  say(`Done. ${metadata.name} ($${metadata.symbol}) is live (${sent.explorer}).`)
  say(confirmed ? `  Its page: ${SITE}/markets/${coin}` : `  Find it on the agent's page: ${SITE}/notes/${wallet.toLowerCase()}`)
  say('  Once it has earned at least 0.5 USDC, move the earnings into the Gateway balance the agent pays APIs from:')
  say('    npx @ubi.fun/agent-kit fund')
}

// --- fund: earnings into the Gateway balance -----------------------------------------------------

/** ubi.fun's FeeEscrow on Arc: creator revenue of coins launched before creator vaults. */
export const FEE_ESCROW = '0x678f0D1C045e820Ec1d4806749f2629e1035550e'
const WITHDRAW_DIVIDEND = '0x6a474002' // withdrawDividend()
const VAULT_CLAIM = '0x4e71d92d' // claim()
const WITHDRAW_FEES = '0x4c2d94c0' // withdrawFees(address,bool)

/** 6-decimal USDC units as the decimal text Circle's CLI takes. */
export function usdcText(units) {
  const whole = units / 1_000_000n
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/**
 * The USDC a get_coin_earnings answer says the wallet can collect, and the transactions that collect
 * it, built here (the answer's own steps are not used): holder dividends and creator earnings of
 * coins with a USDC creator vault, and creator revenue in the FeeEscrow. Pair-paid (v3) coins and
 * unread coins are left out.
 */
export function usdcEarnings(earnings, wallet) {
  const usdc = ARC_USDC.toLowerCase()
  const raw = (value) => (typeof value === 'string' && /^\d{1,30}$/.test(value) ? BigInt(value) : 0n)
  let units = 0n
  let unread = false
  const steps = []
  for (const coin of earnings?.coins ?? []) {
    if (coin?.status === 'unread') {
      unread = true
      continue
    }
    if (coin?.status !== 'vault' || coin.generation !== 'v2' || String(coin.payToken).toLowerCase() !== usdc || coin.decimals !== 6 || !ADDRESS.test(coin.coin ?? '')) continue
    const dividends = raw(coin.holderDividendsRaw)
    const credit = ADDRESS.test(coin.vault ?? '') ? raw(coin.vaultCreditRaw) : 0n
    if (dividends > 0n) {
      units += dividends
      steps.push({ description: `Withdraw holder dividends (USDC) from ${coin.coin}`, to: coin.coin, data: WITHDRAW_DIVIDEND, value: '0' })
    }
    if (credit > 0n) {
      units += credit
      steps.push({ description: `Claim creator earnings (USDC) from the vault of ${coin.coin}`, to: coin.vault, data: VAULT_CLAIM, value: '0' })
    }
  }
  const revenue = earnings?.creatorRevenue
  const owed = revenue && String(revenue.token).toLowerCase() === usdc ? raw(revenue.amountRaw) : 0n
  if (owed > 0n) {
    units += owed
    steps.push({ description: 'Withdraw creator revenue (USDC) from the FeeEscrow', to: FEE_ESCROW, data: `${WITHDRAW_FEES}${wallet.slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}`, value: '0' })
  }
  return { units, steps, unread }
}

/**
 * The USDC these receipts paid `wallet`, net: Arc USDC's ERC-20 Transfer logs (6 decimals) into the
 * wallet minus any out of it. Arc's native-transfer system logs (18 decimals) are not counted.
 */
export function usdcPaidIn(receipts, wallet) {
  const me = BigInt(wallet)
  let net = 0n
  for (const receipt of receipts) {
    for (const log of receipt?.logs ?? []) {
      if (String(log.address).toLowerCase() !== ARC_USDC.toLowerCase()) continue
      const [topic0, from, to] = log.topics ?? []
      if (topic0 !== TRANSFER_TOPIC || !from || !to || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data ?? '')) continue
      const amount = BigInt(log.data)
      if (BigInt(to) === me) net += amount
      if (BigInt(from) === me) net -= amount
    }
  }
  return net > 0n ? net : 0n
}

/** What to deposit: what this run's claims paid, and never more than the wallet still holds. */
export function depositUnits({ collected, balance }) {
  return balance !== null && balance < collected ? balance : collected
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sends the steps 8 at a time (ubi-circle's limit) and stops at the first failure. Returns the
 * confirmed ones, the sent-but-unconfirmed ones (never to be resent) and the failure, if any, so the
 * caller can still account for what landed before it.
 */
export async function sendInBatches(steps, send) {
  const sent = []
  let failure = null
  for (let i = 0; i < steps.length && !failure; i += 8) {
    try {
      sent.push(...(await send(steps.slice(i, i + 8))).results)
    } catch (error) {
      sent.push(...(error.done ?? []))
      failure = error
    }
  }
  return {
    landed: sent.filter((result) => result.status === 'confirmed' && result.txHash),
    unsure: sent.filter((result) => result.txHash && result.status !== 'confirmed'),
    failure,
  }
}

/** A receipt, retried while the RPC has not seen it yet; null if it never shows. */
async function settledReceipt(hash) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const receipt = await receiptOf(hash).catch(() => null)
    if (receipt) return receipt
    await sleep(2_000)
  }
  return null
}

async function fundGateway(args, ctx) {
  const { say, confirm, handOver, interactive } = ctx
  say('ubi.fun Agent Kit: earnings into the Gateway balance')
  say()
  const wallet = await sessionWallet(args, ctx)
  let earnings
  try {
    earnings = await callTool('get_coin_earnings', { address: wallet, ...(args.coins ? { coins: args.coins } : {}) })
  } catch (error) {
    throw new KitError('LOOKUP_FAILED', `Could not read ${wallet}'s earnings (${error.message}). Nothing was sent; run again shortly.`)
  }
  const { units, steps, unread } = usdcEarnings(earnings, wallet)
  // The server's own coverage warning: more than 50 coins, or reads that failed
  if (typeof earnings?.note === 'string' && earnings.note) say(`  Note: ${earnings.note.replace('pass coins', 'pass --coins')}`)
  else if (unread) say('  Some coins could not be read just now; they are left for the next run.')
  if (units === 0n) {
    say('  Nothing to collect yet: no USDC earnings on ubi.fun for this wallet.')
    return
  }
  if (units < GATEWAY_MIN_UNITS) {
    say(`  ${usdcText(units)} USDC earned so far. It is collected once it reaches ${GATEWAY_MIN_USDC} USDC, Circle's minimum Gateway deposit.`)
    return
  }
  if (!interactive && !args.yes) throw new KitError('NEEDS_YES', 'This moves USDC: run it in a terminal, or pass --yes (for a scheduled run)')
  // It moves USDC: only a typed "y" (or --yes) goes ahead
  if (!(await confirm(`Collect ${usdcText(units)} USDC of earnings into ${wallet} and move it into its Gateway balance?`, false))) throw new KitError('CANCELLED', 'Nothing was sent')
  // The claims, then what their receipts paid: only that moves on. A second run at the same time
  // claims nothing, its receipts pay nothing, and it deposits nothing. If a claim fails, the ones
  // that landed before it are still counted and deposited, and the failure is reported at the end.
  const { landed, unsure, failure } = await sendInBatches(steps, (batch) => sendSteps(wallet, { steps: batch }))
  const failed = () =>
    new KitError(
      failure.code ?? 'CLAIM_FAILED',
      `${failure.message}${unsure.length ? ` Not confirmed (do not resend; if it lands, its USDC stays in the wallet): ${unsure.map((result) => result.explorer).join(' ')}` : ''}${landed.length ? ' The claims before it were handled above.' : ''} Run fund again later for what is left.`,
    )
  if (landed.length === 0) {
    if (failure) throw failed()
    throw new KitError('SEND_FAILED', 'No claim was confirmed. Nothing was deposited.')
  }
  for (const result of landed) say(`  Collected (${result.explorer})`)
  const receipts = await Promise.all(landed.map((result) => settledReceipt(result.txHash)))
  if (receipts.some((receipt) => receipt === null)) {
    say("  Could not read every claim's receipt, so nothing was deposited. The USDC they paid is in the wallet (see the links above).")
    say('  Move it yourself once you see the amount there: ask your agent "Use ubi-circle: move <amount> USDC into my Gateway balance"')
    if (failure) throw failed()
    throw new KitError('NOT_DEPOSITED', 'Claimed, but the receipts could not be read, so nothing was deposited (see above).')
  }
  const collected = usdcPaidIn(receipts, wallet)
  const balance = await usdcBalance(wallet)
  const deposit = depositUnits({ collected, balance })
  if (deposit < GATEWAY_MIN_UNITS) {
    say(
      collected < GATEWAY_MIN_UNITS
        ? `  The claims paid ${usdcText(collected)} USDC, under Circle's ${GATEWAY_MIN_USDC} USDC minimum deposit, so it stays in the wallet.`
        : `  The claims paid ${usdcText(collected)} USDC, but the wallet now holds only ${usdcText(balance ?? 0n)} USDC, under Circle's ${GATEWAY_MIN_USDC} USDC minimum deposit, so nothing was deposited.`,
    )
    if (failure) throw failed()
    throw new KitError('NOT_DEPOSITED', `Claimed ${usdcText(collected)} USDC, but nothing was deposited (see above); it is in the wallet.`)
  }
  const amount = usdcText(deposit)
  const result = await handOver(() => ubiCircle(gatewayDepositArgs(amount, wallet), { inherit: true }))
  if (result.code !== 0) {
    // The CLI can fail after it submitted: the deposit may still land, so never suggest sending it again
    say(`  The ${amount} USDC deposit did not confirm, and it may still land. Before moving that USDC again, check the`)
    say('  Gateway balance and the wallet\'s recent transactions (ask your agent "Use ubi-circle: show my Gateway balance')
    say('  and recent transactions"). Running fund again never re-deposits it: fund only moves what new claims pay.')
    if (failure) throw failed()
    throw new KitError('DEPOSIT_UNCONFIRMED', `The ${amount} USDC deposit did not confirm and may still land. Do not resend; check first (see above).`)
  }
  say()
  say(`Done. Moved ${amount} USDC of earnings into ${wallet}'s Gateway balance.`)
  if (deposit < collected) say(`  ${usdcText(collected - deposit)} USDC of what the claims paid had already left the wallet, so it was not deposited.`)
  say("  It pays for services in Circle's Agent Marketplace: agents.circle.com/services")
  if (failure) throw failed()
}

/** Sends a prepare_* result through ubi-circle and returns the last step's hash and link. */
async function sendSteps(wallet, prepared) {
  const dir = mkdtempSync(join(tmpdir(), 'ubi-agent-kit-'))
  const file = join(dir, 'steps.json')
  try {
    writeFileSync(file, JSON.stringify(prepared), { mode: 0o600 })
    const sent = await ubiCircle(['send', '--address', wallet, '--file', file])
    if (!sent.json?.ok) {
      const error = sent.json ?? { code: 'SEND_FAILED', message: sent.stderr.trim() || 'Circle did not send the transaction' }
      const failure = new KitError(error.code, `${error.message}${error.done?.length ? ` (sent so far: ${JSON.stringify(error.done)})` : ''}`)
      // The steps that were sent before the failure, for a caller that has to account for them
      failure.done = Array.isArray(error.done) ? error.done : []
      throw failure
    }
    const results = sent.json.results
    const last = results.at(-1)
    return { txHash: last.txHash, explorer: last.explorer, results }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
