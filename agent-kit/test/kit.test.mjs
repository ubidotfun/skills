import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { agentIdFromLogs, agentIdsHeld, ARC_USDC, callTool, chooseGatewayDeposit, gatewayAmount, gatewayDepositArgs, HELP, KitError, main, normalizeX, parseArgs, profileArgs, REGISTRY, usdcBalance } from '../lib/kit.mjs'

const WALLET = '0x6029135d3494ec032e7726b0c78768d327a2beb8'
const sha = (path) => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')

test('lib/ubi-circle.mjs is the skill script byte for byte', { skip: !existsSync(new URL('../../skills/ubi-circle/scripts/ubi-circle.mjs', import.meta.url)) }, () => {
  assert.equal(sha('../lib/ubi-circle.mjs'), sha('../../skills/ubi-circle/scripts/ubi-circle.mjs'))
})

test('parseArgs reads values and switches, and refuses the rest', () => {
  assert.deepEqual(parseArgs(['--name', 'Scout', '--yes', '--x', '@scout', '--skip-skills']), { name: 'Scout', yes: true, x: '@scout', skipSkills: true })
  assert.throws(() => parseArgs(['--name']), /needs a value/)
  assert.throws(() => parseArgs(['--name', '--yes']), /needs a value/)
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/)
  assert.throws(() => parseArgs(['--address', '0x123']), /0x address/)
  assert.deepEqual(parseArgs(['--agent-id', '424080']), { agentId: '424080' })
  assert.throws(() => parseArgs(['--agent-id', '42x']), /must be a number/)
  assert.throws(() => parseArgs(['--agent-id', '1', '--wallet', WALLET]), /not with --wallet/)
})

test('--gateway takes a USDC amount for the Circle wallet only, and never with --skip-gateway', () => {
  assert.deepEqual(parseArgs(['--gateway', '0.5']), { gateway: '0.5' })
  assert.deepEqual(parseArgs(['--skip-gateway']), { skipGateway: true })
  // 0.5 is Circle CLI 1.2.2's minimum Gateway deposit: anything below would fail after the four steps
  for (const bad of ['0', '-1', 'abc', '1.1234567', '1e3', '1001', '0.1', '0.499999']) assert.throws(() => parseArgs(['--gateway', bad]), KitError)
  assert.throws(() => parseArgs(['--gateway', '1', '--wallet', WALLET]), /not with --wallet/)
  assert.throws(() => parseArgs(['--gateway', '1', '--skip-gateway']), /not both/)
  assert.equal(gatewayAmount(' 2 '), '2')
})

test('usdcBalance reads Arc USDC through its ERC-20 interface and gives null when it cannot', async () => {
  const calls = []
  const answer = (result) => async (_url, init) => (calls.push(JSON.parse(init.body)), { json: async () => ({ jsonrpc: '2.0', id: 1, result }) })
  assert.equal(await usdcBalance(WALLET, answer(`0x${'0'.repeat(58)}0f4240`)), 1_000_000n)
  assert.deepEqual(calls[0].params[0], { to: ARC_USDC, data: `0x70a08231${'0'.repeat(24)}${WALLET.slice(2)}` })
  assert.equal(await usdcBalance(WALLET, answer(undefined)), null)
  assert.equal(await usdcBalance(WALLET, async () => { throw new Error('offline') }), null)
})

test('the Gateway deposit happens only on --gateway or a typed amount after "y", never by default', async () => {
  const ask = (...answers) => {
    const asked = []
    return { asked, rl: { question: async (q) => (asked.push(q), answers.shift() ?? '') } }
  }
  const said = []
  const say = (line) => said.push(line)
  const has = (units) => async () => units
  const choose = (args, rl, balanceOf) => chooseGatewayDeposit({ args, rl, wallet: WALLET, say, balanceOf })

  assert.equal(await choose({ gateway: '2' }, null, has(0n)), '2')
  assert.equal(await choose({ skipGateway: true }, ask('y', '5').rl, has(9_000_000n)), null)
  assert.equal(await choose({ yes: true }, null, has(9_000_000n)), null)
  // An unreadable or too-small balance asks nothing
  for (const balance of [null, 0n, 499_999n]) {
    const t = ask('y', '1')
    assert.equal(await choose({}, t.rl, has(balance)), null)
    assert.equal(t.asked.length, 0)
  }
  assert.equal(await choose({}, ask('', '1').rl, has(9_000_000n)), null)
  assert.equal(await choose({}, ask('n', '1').rl, has(9_000_000n)), null)
  // "y" then Enter: no default amount
  assert.equal(await choose({}, ask('y', '').rl, has(9_000_000n)), null)
  assert.equal(await choose({}, ask('y', '0.1').rl, has(9_000_000n)), null)
  assert.equal(await choose({ yes: true }, ask('y', '2.5').rl, has(9_000_000n)), '2.5')
})

test('the Gateway deposit is the stock Circle CLI command on Arc, direct method', () => {
  assert.deepEqual(gatewayDepositArgs('1', WALLET), ['circle', 'gateway', 'deposit', '--amount', '1', '--address', WALLET, '--chain', 'ARC', '--method', 'direct'])
})

test('agentIdsHeld reads the registry balance and refuses a malformed answer', async () => {
  const calls = []
  const answer = (result) => async (url, init) => (calls.push(JSON.parse(init.body)), { json: async () => ({ jsonrpc: '2.0', id: 1, result }) })
  assert.equal(await agentIdsHeld(WALLET, answer(`0x${'0'.repeat(63)}2`)), 2n)
  assert.deepEqual(calls[0].params[0], { to: REGISTRY, data: `0x70a08231${'0'.repeat(24)}${WALLET.slice(2)}` })
  await assert.rejects(agentIdsHeld(WALLET, answer(undefined)), /Could not read the registry/)
  await assert.rejects(agentIdsHeld(WALLET, async () => ({ json: async () => ({ error: { code: -32000, message: 'down' } }) })), /Nothing was sent/)
})

test('profileArgs keeps only given fields and checks the X handle', () => {
  assert.deepEqual(profileArgs({ name: ' Scout ', description: 'Finds coins. ', x: 'https://x.com/scout' }), { name: 'Scout', description: 'Finds coins.', x: '@scout' })
  assert.deepEqual(profileArgs({ name: 'S', description: 'D', image: 'https://a.example/i.png', website: 'https://a.example' }), {
    name: 'S',
    description: 'D',
    imageUrl: 'https://a.example/i.png',
    website: 'https://a.example',
  })
  assert.throws(() => profileArgs({ name: 'S', description: 'D', x: 'not a handle!' }), KitError)
  assert.equal(normalizeX('@ubidotfun'), '@ubidotfun')
  assert.equal(normalizeX('https://evil.example/ubidotfun'), undefined)
})

test('agentIdFromLogs finds the ID minted to the wallet only', () => {
  const mint = {
    address: REGISTRY.toLowerCase(),
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x${'0'.repeat(64)}`,
      `0x000000000000000000000000${WALLET.slice(2)}`,
      '0x0000000000000000000000000000000000000000000000000000000000067890',
    ],
  }
  assert.equal(agentIdFromLogs([mint], WALLET), '424080')
  assert.equal(agentIdFromLogs([{ ...mint, address: '0x0000000000000000000000000000000000000001' }], WALLET), null)
  assert.equal(agentIdFromLogs([mint], '0x000000000000000000000000000000000000dEaD'), null)
  assert.equal(agentIdFromLogs(undefined, WALLET), null)
})

test('callTool returns the parsed result and throws the tool error text', async () => {
  const reply = (body) => async () => ({ ok: true, json: async () => body })
  assert.deepEqual(await callTool('x', {}, { fetchImpl: reply({ result: { content: [{ type: 'text', text: '{"a":1}' }] } }) }), { a: 1 })
  await assert.rejects(
    callTool('x', {}, { fetchImpl: reply({ result: { content: [{ type: 'text', text: 'MCP error -32602: bad wallet' }], isError: true } }) }),
    /^KitError: bad wallet$|bad wallet/,
  )
  await assert.rejects(callTool('x', {}, { fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/)
})

function io(input = '') {
  let out = ''
  const stdin = Readable.from([input])
  stdin.isTTY = false
  const stdout = new Writable({ write: (chunk, _enc, done) => ((out += chunk), done()) })
  return { io: { stdin, stdout }, output: () => out }
}

test('--help prints the usage', async () => {
  const t = io()
  await main(['--help'], t.io)
  assert.equal(t.output(), HELP)
})

test('without a terminal it needs --name and --description', async () => {
  const t = io()
  await assert.rejects(main([], t.io), /needs a name and a description/)
})

test('--wallet prints the prepared transaction and sends nothing', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, name: body.params.name, args: body.params.arguments })
    const steps = [{ description: 'Register the Agent ID', to: REGISTRY, data: '0x1234', value: '0', chainId: 5042 }]
    return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify({ steps }) }] } }) }
  }
  try {
    const t = io()
    await main(['--wallet', WALLET, '--name', 'Scout', '--description', 'Finds coins.'], t.io)
    assert.deepEqual(calls.map((c) => c.name), ['prepare_agent_id'])
    assert.deepEqual(calls[0].args, { wallet: WALLET, name: 'Scout', description: 'Finds coins.' })
    assert.match(t.output(), /"to": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"/)
  } finally {
    globalThis.fetch = realFetch
  }
})
