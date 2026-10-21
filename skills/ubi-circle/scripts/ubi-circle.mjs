#!/usr/bin/env node
// ubi-circle: send the unsigned steps from the ubi.fun MCP server (prepare_swap, prepare_launch,
// prepare_launch_v3, claims) from a Circle Agent Wallet on Arc mainnet.
//
// Circle's CLI signs and submits. It only accepts "function signature + text arguments", which
// cannot carry the lists and structs a Universal Router swap or a launch needs, while Circle's
// API itself accepts raw calldata (`callData` on user contract execution). `setup` installs one
// pinned Circle CLI version into ~/.ubi-circle, checks its hash, and writes a copy beside it that
// adds a `--call-data` flag for Circle Agent Wallets only. The installed CLI file is not changed.
//
// No key, email code or session token ever passes through this script: you log in with the
// Circle CLI in your own terminal, and the session stays in ~/.ubi-circle/home.
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CLI_PACKAGE = '@circle-fin/cli'
const CLI_VERSION = '1.2.2'
const CLI_SHA256 = '12b484ff7b1b23666ee9e2784d811bfa366b7af0fef4d842ea82e1dc8693b56e'
const PATCH_ID = 'ubi-circle-calldata-v1'
const CHAIN_ID = 5042
const RPC_URL = process.env.UBI_CIRCLE_RPC_URL ?? 'https://rpc.mainnet.arc.io'
const ROOT = process.env.UBI_CIRCLE_ROOT ?? join(homedir(), '.ubi-circle')
const RUNTIME = join(ROOT, 'runtime')
const CLI_HOME = join(ROOT, 'home')
const DIST = join(RUNTIME, 'node_modules', '@circle-fin', 'cli', 'dist')
const STOCK = join(DIST, 'index.js')
const PATCHED = join(DIST, 'ubi-calldata.mjs')
const MANIFEST = join(ROOT, 'patch.json')

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

class Stop extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

// ---------------------------------------------------------------------------------------------
// The patch: exact anchors in @circle-fin/cli 1.2.2, each required to occur exactly once.

export function patchCircleSource(original) {
  if (sha256(original) !== CLI_SHA256) {
    throw new Stop('CLI_MISMATCH', `Expected the unmodified ${CLI_PACKAGE}@${CLI_VERSION} build`)
  }
  let out = original
  const replace = (from, to) => {
    if (out.split(from).length !== 2) throw new Stop('PATCH_ANCHOR', `Patch anchor not found exactly once: ${from.slice(0, 60)}`)
    out = out.replace(from, to)
  }
  // 1. The hex after --call-data is a flag value, not a positional ABI argument.
  replace(
    '    "--idempotency-key",\n    "--amount",\n    "--collateral",',
    '    "--idempotency-key",\n    "--call-data",\n    "--amount",\n    "--collateral",',
  )
  // 2. wallet execute: raw calldata replaces the signature and its arguments, on ARC only.
  replace(
    '  const abiFunctionSignature = pos[0];\n  if (!abiFunctionSignature) {\n    outputError(\n      "Missing required argument: <abiFunctionSignature>. Run --help for usage.",',
    `  const abiFunctionSignature = pos[0];
  const ubiCallData = readFlagValue(args2, "--call-data");
  if (args2.includes("--call-data") && (args2.filter((v) => v === "--call-data").length !== 1
      || typeof ubiCallData !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(ubiCallData)
      || pos.length !== 0 || blockchain !== "ARC")) {
    outputError("--call-data needs one hex value, no ABI arguments, and --chain ARC.", args2, "INVALID_ARGUMENT");
    process.exitCode = 1;
    return;
  }
  if (!abiFunctionSignature && !ubiCallData) {
    outputError(
      "Missing required argument: <abiFunctionSignature>. Run --help for usage.",`,
  )
  // 3. Local wallets keep the stock behavior: raw calldata goes to Circle Agent Wallets only.
  replace(
    '  if (resolved.wallet.type === "local") {\n    if (estimate) {\n      await handleLocalExecuteEstimate(',
    `  if (resolved.wallet.type === "local") {
    if (args2.includes("--call-data")) {
      outputError("--call-data is only for Circle Agent Wallets.", args2, "INVALID_ARGUMENT");
      process.exitCode = 1;
      return;
    }
    if (estimate) {
      await handleLocalExecuteEstimate(`,
  )
  // 4. The agent path sends { callData } in place of { abiFunctionSignature, abiParameters }.
  replace(
    'async function handleAgentExecute(wallet, env, blockchain, contractAddress, abiFunctionSignature, abiParameters, value, estimate, args2) {\n  const proxyUrl',
    `async function handleAgentExecute(wallet, env, blockchain, contractAddress, abiFunctionSignature, abiParameters, value, estimate, args2) {
  const ubiCallData = readFlagValue(args2, "--call-data");
  const ubiCall = ubiCallData ? { callData: ubiCallData } : { abiFunctionSignature, abiParameters: abiParameters.length > 0 ? abiParameters : void 0 };
  const proxyUrl`,
  )
  replace(
    '        contractAddress,\n        abiFunctionSignature,\n        abiParameters: abiParameters.length > 0 ? abiParameters : void 0,\n        amount: value !== "0" ? value : void 0',
    '        contractAddress,\n        ...ubiCall,\n        amount: value !== "0" ? value : void 0',
  )
  replace(
    '    idempotencyKey,\n    contractAddress,\n    abiFunctionSignature,\n    abiParameters: abiParameters.length > 0 ? abiParameters : void 0,\n    amount: value !== "0" ? value : void 0',
    '    idempotencyKey,\n    contractAddress,\n    ...ubiCall,\n    amount: value !== "0" ? value : void 0',
  )
  return out
}

// ---------------------------------------------------------------------------------------------

function run(file, args, { timeoutMs = 180_000, inherit = false } = {}) {
  const env = { ...process.env, CIRCLE_CLI_HOME: CLI_HOME, CIRCLE_VERSION_CHECK: 'off', DO_NOT_TRACK: '1' }
  if (inherit) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [file, ...args], { env, stdio: 'inherit' })
      child.on('close', (code) => resolve({ code }))
    })
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr, interrupted: Boolean(error?.killed || error?.signal) })
    })
  })
}

function verifyRuntime() {
  if (!existsSync(STOCK) || !existsSync(PATCHED) || !existsSync(MANIFEST)) {
    throw new Stop('NOT_SET_UP', 'Run: node ubi-circle.mjs setup')
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  if (manifest.patchId !== PATCH_ID || manifest.upstreamVersion !== CLI_VERSION
      || sha256(readFileSync(STOCK, 'utf8')) !== CLI_SHA256 || sha256(readFileSync(PATCHED, 'utf8')) !== manifest.patchedSha256) {
    throw new Stop('RUNTIME_MISMATCH', 'The Circle runtime in ~/.ubi-circle changed. Run setup again.')
  }
}

async function setup() {
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 })
  mkdirSync(CLI_HOME, { recursive: true, mode: 0o700 })
  if (!existsSync(STOCK) || sha256(readFileSync(STOCK, 'utf8')) !== CLI_SHA256) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const result = await new Promise((resolve) => {
      execFile(npm, ['install', '--prefix', RUNTIME, '--ignore-scripts', '--no-audit', '--no-fund', `${CLI_PACKAGE}@${CLI_VERSION}`],
        { timeout: 300_000, shell: process.platform === 'win32' }, (error, stdout, stderr) => resolve({ error, stderr }))
    })
    if (result.error) throw new Stop('INSTALL_FAILED', `npm install failed: ${result.stderr}`)
  }
  const original = readFileSync(STOCK, 'utf8')
  const patched = patchCircleSource(original)
  writeFileSync(PATCHED, patched, { mode: 0o600 })
  const manifest = {
    patchId: PATCH_ID,
    upstreamPackage: CLI_PACKAGE,
    upstreamVersion: CLI_VERSION,
    upstreamSha256: CLI_SHA256,
    patchedSha256: sha256(patched),
    change: 'wallet execute accepts --call-data <hex> for Circle Agent Wallets on ARC; everything else is the stock CLI',
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  print({ ok: true, ...manifest, cliHome: CLI_HOME,
    next: [
      'In YOUR terminal (never through an agent): node ubi-circle.mjs circle terms show, then circle terms accept',
      'node ubi-circle.mjs circle wallet login YOUR_EMAIL --type agent   (type the emailed code there)',
      'node ubi-circle.mjs wallets',
    ] })
}

// One JSON-RPC call, checked before anything trusts it: version 2.0, this request's fresh id, and
// exactly one of an error object or a result that passes `valid`. Anything else throws RPC_INVALID,
// so a malformed answer can never read as a passed simulation or a receipt.
async function rpc(method, params, valid) {
  const id = randomUUID()
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Stop('RPC_UNAVAILABLE', `Arc RPC answered HTTP ${response.status}`)
  const invalid = (why) => new Stop('RPC_INVALID', `Arc RPC answered ${method} with ${why}`)
  let payload
  try { payload = JSON.parse(await response.text()) } catch { throw invalid('a body that is not JSON') }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('something other than one response object')
  if (payload.jsonrpc !== '2.0' || payload.id !== id) throw invalid('a different version or request id')
  const hasResult = Object.hasOwn(payload, 'result')
  if (hasResult === Object.hasOwn(payload, 'error')) throw invalid('both or neither of result and error')
  if (!hasResult) {
    const { error } = payload
    if (!error || typeof error !== 'object' || !Number.isInteger(error.code) || typeof error.message !== 'string') throw invalid('a malformed error')
    return { error }
  }
  if (!valid(payload.result)) throw invalid('a malformed result')
  return { result: payload.result }
}

const isCallResult = (r) => typeof r === 'string' && HEX.test(r)
const isRevert = (error) => error.code === 3 || /revert/i.test(error.message)

async function agentWallets() {
  const result = await run(STOCK, ['wallet', 'list', '--type', 'agent', '--chain', 'ARC', '--output', 'json'], { timeoutMs: 60_000 })
  let payload
  try { payload = JSON.parse(result.stdout) } catch { payload = null }
  const wallets = payload?.data?.wallets
  if (result.code !== 0 || !Array.isArray(wallets)) {
    throw new Stop('CIRCLE_NOT_READY', 'No Circle session. Log in with: node ubi-circle.mjs circle wallet login YOUR_EMAIL --type agent', { stderr: result.stderr?.trim() })
  }
  return wallets.filter((w) => w.blockchain === 'ARC' && typeof w.address === 'string')
}

/** Accepts a prepare_* tool result, its `steps` array, or one step. */
export function readSteps(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input
  const steps = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.steps) ? parsed.steps : parsed?.to ? [parsed] : null
  if (!steps || steps.length === 0) throw new Stop('NO_STEPS', 'Input has no steps. Pass the JSON a ubi prepare_* tool returned.')
  if (steps.length > 8) throw new Stop('TOO_MANY_STEPS', 'More than 8 steps in one request')
  return steps.map((step, index) => {
    if (step.chainId !== undefined && Number(step.chainId) !== CHAIN_ID) throw new Stop('WRONG_CHAIN', `Step ${index + 1} is for chain ${step.chainId}, not Arc (${CHAIN_ID})`)
    if (!ADDRESS.test(step.to ?? '')) throw new Stop('BAD_STEP', `Step ${index + 1} has no valid "to" address`)
    if (typeof step.data !== 'string' || !HEX.test(step.data) || step.data.length < 10) throw new Stop('BAD_STEP', `Step ${index + 1} has no calldata`)
    const value = String(step.value ?? '0')
    if (!/^(0|[1-9][0-9]{0,40})$/.test(value)) throw new Stop('BAD_STEP', `Step ${index + 1} value must be a decimal integer in wei`)
    return { description: String(step.description ?? `step ${index + 1}`), to: step.to, data: step.data, value }
  })
}

/** Wei (18 decimals, Arc's native USDC) to the decimal string Circle's --amount takes. */
export function weiToDecimal(wei) {
  const v = BigInt(wei)
  const whole = v / 10n ** 18n
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** ok only for a well-formed eth_call result; a revert is { ok: false }, any other answer throws. */
export async function simulate(from, step) {
  const { error } = await rpc('eth_call', [{ from, to: step.to, data: step.data, value: `0x${BigInt(step.value).toString(16)}` }, 'latest'], isCallResult)
  if (!error) return { ok: true }
  if (isRevert(error)) return { ok: false, error: error.message, data: error.data }
  throw new Stop('RPC_UNAVAILABLE', `Arc RPC could not run the simulation: ${error.code} ${error.message}`)
}

async function waitReceipt(hash, timeoutMs = 120_000) {
  const isReceipt = (r) => r === null || (typeof r === 'object' && same(r.transactionHash, hash) && (r.status === '0x1' || r.status === '0x0'))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { result, error } = await rpc('eth_getTransactionReceipt', [hash], isReceipt)
    if (error) throw new Stop('RPC_UNAVAILABLE', `${error.code} ${error.message}`)
    if (result) return result
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return null
}

async function send(args) {
  verifyRuntime()
  const address = args.address
  if (!ADDRESS.test(address ?? '')) throw new Stop('BAD_ARGUMENT', '--address <your Circle Agent Wallet on ARC> is required')
  const raw = args.file ? readFileSync(args.file, 'utf8') : readFileSync(0, 'utf8')
  const steps = readSteps(raw)
  const wallets = await agentWallets()
  if (!wallets.some((w) => same(w.address, address))) throw new Stop('WALLET_NOT_FOUND', `${address} is not one of your Circle Agent Wallets on ARC`)

  const results = []
  for (const [index, step] of steps.entries()) {
    // Each step is simulated against the chain as it is right now, after the previous step landed.
    // A failed read here happens before anything of this step is sent; earlier steps stay reported.
    let sim
    try {
      sim = await simulate(address, step)
    } catch (error) {
      throw new Stop(error.code ?? 'RPC_UNAVAILABLE', `Step ${index + 1} (${step.description}) could not be simulated (${error.message}). Nothing of this step was sent.`, { done: results })
    }
    if (!sim.ok) {
      throw new Stop('SIMULATION_FAILED', `Step ${index + 1} (${step.description}) would revert: ${sim.error}. Nothing more was sent.`, { done: results, revertData: sim.data })
    }
    if (args.dryRun) {
      results.push({ step: index + 1, description: step.description, simulated: true })
      if (steps.length > 1) results.push({ note: 'Later steps depend on this one landing, so a dry run checks the first step only.' })
      break
    }
    const idempotencyKey = randomUUID()
    const result = await run(PATCHED, ['wallet', 'execute', '--call-data', step.data, '--contract', step.to, '--address', address,
      '--chain', 'ARC', '--amount', weiToDecimal(step.value), '--idempotency-key', idempotencyKey, '--output', 'json'])
    let data = null
    try { data = JSON.parse(result.stdout)?.data ?? null } catch { /* reported below */ }
    const hash = typeof data?.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(data.txHash) ? data.txHash : null
    if (result.code !== 0 || result.interrupted || !hash) {
      // After the request went out, the transaction may still land: never resend automatically.
      // A hash Circle printed before failing is kept, so the outcome can still be looked up.
      const known = hash ? { txHash: hash, explorer: `https://arc.etherscan.io/tx/${hash}` } : {}
      throw new Stop('OUTCOME_UNKNOWN', `Step ${index + 1} (${step.description}): Circle did not ${hash ? 'finish cleanly' : 'confirm a transaction hash'}. Do NOT resend. Check with: node ubi-circle.mjs circle transaction list --address ${address} --chain ARC`, {
        done: [...results, { step: index + 1, description: step.description, idempotencyKey, ...known, status: 'unknown' }],
        idempotencyKey, ...known, circleState: data?.state, stderr: result.stderr?.trim().slice(0, 500) })
    }
    // Sent: from here every outcome carries the hash and the key, so nothing is ever sent twice
    const sent = { step: index + 1, description: step.description, txHash: hash, idempotencyKey, explorer: `https://arc.etherscan.io/tx/${hash}` }
    let receipt
    try {
      receipt = await waitReceipt(hash)
    } catch (error) {
      throw new Stop('RECEIPT_UNKNOWN', `Step ${index + 1} (${step.description}) was sent (${hash}) but its receipt could not be read (${error.message}). Do NOT resend: check the explorer link, then prepare fresh steps for whatever is left.`, {
        done: [...results, { ...sent, status: 'unknown' }] })
    }
    const status = receipt ? (receipt.status === '0x1' ? 'confirmed' : 'reverted') : 'pending'
    results.push({ ...sent, status })
    if (status !== 'confirmed') {
      throw new Stop(status === 'reverted' ? 'REVERTED' : 'PENDING', `Step ${index + 1} ${status}. Stopped before the next step.`, { done: results })
    }
  }
  print({ ok: true, address, results })
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--address') args.address = argv[++i]
    else if (a === '--file') args.file = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else args._.push(a)
  }
  return args
}

const HELP = `ubi-circle: send ubi.fun MCP steps from a Circle Agent Wallet on Arc

  node ubi-circle.mjs setup                              install the pinned Circle CLI + calldata flag
  node ubi-circle.mjs circle <args...>                   run the stock Circle CLI (login, terms, balances)
  node ubi-circle.mjs wallets                            list your Circle Agent Wallets on ARC
  node ubi-circle.mjs send --address 0x... [--file steps.json] [--dry-run]
                                                         simulate, then send each step in order (stdin if no --file)
`

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'setup') return setup()
  if (command === 'circle') {
    verifyRuntime()
    const { code } = await run(STOCK, rest, { inherit: true })
    process.exitCode = code ?? 0
    return
  }
  if (command === 'wallets') {
    verifyRuntime()
    const wallets = await agentWallets()
    return print({ ok: true, wallets: wallets.map((w) => ({ address: w.address, type: w.type, accountType: w.accountType, state: w.state })) })
  }
  if (command === 'send') return send(parseArgs(rest))
  process.stdout.write(HELP)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    print({ ok: false, code: error.code ?? 'ERROR', message: error.message, ...(error.extra ?? {}) })
    process.exitCode = 1
  })
}
