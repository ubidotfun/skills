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

const VALUE_FLAGS = { '--name': 'name', '--description': 'description', '--image': 'image', '--website': 'website', '--x': 'x', '--mcp': 'mcp', '--a2a': 'a2a', '--address': 'address', '--wallet': 'wallet', '--agent-id': 'agentId', '--gateway': 'gateway' }
const BOOL_FLAGS = { '--yes': 'yes', '-y': 'yes', '--skip-connect': 'skipConnect', '--skip-skills': 'skipSkills', '--skip-gateway': 'skipGateway', '--help': 'help', '-h': 'help' }
/** The most the kit deposits into a Gateway balance in one run; more goes through the Circle CLI directly. */
export const GATEWAY_MAX_USDC = 1000

/** A deposit amount in USDC: up to 6 decimals, above 0, at most GATEWAY_MAX_USDC. */
export function gatewayAmount(value) {
  const text = String(value).trim()
  if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) <= 0) throw new KitError('BAD_ARGUMENT', '--gateway must be a USDC amount above 0, like 1 or 0.5')
  if (Number(text) > GATEWAY_MAX_USDC) throw new KitError('BAD_ARGUMENT', `--gateway is capped at ${GATEWAY_MAX_USDC} USDC here; deposit more with the Circle CLI`)
  return text
}

/** Circle CLI 1.2.2: moves USDC from the agent wallet into its Gateway balance on Arc. */
export function gatewayDepositArgs(amount, wallet) {
  return ['circle', 'gateway', 'deposit', '--amount', amount, '--address', wallet, '--chain', 'ARC', '--method', 'direct']
}

export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
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
  for (const key of ['address', 'wallet']) {
    if (args[key] !== undefined && !ADDRESS.test(args[key])) throw new KitError('BAD_ARGUMENT', `--${key} must be a 0x address`)
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
  --gateway <usdc>                           also move this much USDC into the wallet's Circle Gateway balance,
                                             to pay for services in Circle's Agent Marketplace (asked when not given)
  --yes                                      no confirmation prompts (Circle's terms and login still need you;
                                             --yes never moves USDC into Gateway, only --gateway does)
  --skip-connect --skip-skills --skip-gateway  leave Claude Code, the skills and the Gateway balance as they are

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
    const list = wallets.json.wallets ?? []
    if (list.length === 0) throw new KitError('NO_WALLET', 'Your Circle account has no agent wallet on Arc yet')
    let wallet = list[0].address
    if (args.address) {
      const chosen = list.find((w) => w.address.toLowerCase() === args.address.toLowerCase())
      if (!chosen) throw new KitError('WALLET_NOT_FOUND', `${args.address} is not one of your Circle Agent Wallets on Arc`)
      wallet = chosen.address
    } else if (list.length > 1 && rl) {
      list.forEach((w, i) => say(`  ${i + 1}. ${w.address}`))
      const pick = Number(await ask(`Which wallet? [1-${list.length}, default 1] `, '1'))
      wallet = list[Math.min(Math.max(pick, 1), list.length) - 1].address
    }
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
    let deposit = args.gateway ?? null
    // A new wallet is usually still empty here: only offer the deposit when it holds USDC
    const held = deposit || args.skipGateway || !rl ? null : await usdcBalance(wallet)
    if (held === 0n) say('  The wallet has no USDC on Arc yet; fund it first (see below).')
    if (!deposit && !args.skipGateway && rl && held !== 0n) {
      const wants = (await rl.question('Move USDC from this wallet into its Gateway balance now? [y/N] ')).trim().toLowerCase().startsWith('y')
      if (wants) {
        // The identity is done by now: a mistyped amount skips this step instead of failing the run
        try {
          deposit = gatewayAmount(await ask('How much USDC? [1] ', '1'))
        } catch {
          say('  That is not a USDC amount (like 1 or 0.5).')
        }
      }
    }
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

/** Sends a prepare_* result through ubi-circle and returns the last step's hash and link. */
async function sendSteps(wallet, prepared) {
  const dir = mkdtempSync(join(tmpdir(), 'ubi-agent-kit-'))
  const file = join(dir, 'steps.json')
  try {
    writeFileSync(file, JSON.stringify(prepared), { mode: 0o600 })
    const sent = await ubiCircle(['send', '--address', wallet, '--file', file])
    if (!sent.json?.ok) {
      const error = sent.json ?? { code: 'SEND_FAILED', message: sent.stderr.trim() || 'Circle did not send the transaction' }
      throw new KitError(error.code, `${error.message}${error.done?.length ? ` (sent so far: ${JSON.stringify(error.done)})` : ''}`)
    }
    const last = sent.json.results.at(-1)
    return { txHash: last.txHash, explorer: last.explorer }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
