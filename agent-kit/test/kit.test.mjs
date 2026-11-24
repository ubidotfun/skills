import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { agentIdFromLogs, agentIdsHeld, ARC_USDC, callTool, chooseGatewayDeposit, depositUnits, FEE_ESCROW, gatewayAmount, gatewayDepositArgs, HELP, KitError, main, normalizeX, parseArgs, profileArgs, REGISTRY, sendInBatches, simulatedCoin, tickerOf, tokenMetadataArgs, usdcBalance, usdcEarnings, usdcPaidIn, usdcText } from '../lib/kit.mjs'

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

test('commands: token and fund take only their own options', () => {
  assert.deepEqual(parseArgs(['token', '--symbol', 'OOBIE', '--yes']), { command: 'token', symbol: 'OOBIE', yes: true })
  assert.deepEqual(parseArgs(['fund', '--address', WALLET, '--yes']), { command: 'fund', address: WALLET, yes: true })
  assert.deepEqual(parseArgs(['fund']), { command: 'fund' })
  assert.throws(() => parseArgs(['launch']), /Unknown command/)
  assert.throws(() => parseArgs(['fund', '--gateway', '1']), /does not work with the fund command/)
  assert.throws(() => parseArgs(['fund', '--symbol', 'X']), /does not work with the fund command/)
  assert.throws(() => parseArgs(['token', '--wallet', WALLET]), /does not work with the token command/)
  assert.throws(() => parseArgs(['--symbol', 'X']), /does not work with the setup run/)
  // A command is only ever the first word
  assert.throws(() => parseArgs(['--yes', 'fund']), /Unknown option fund/)
  const coin = '0x01918708170577127007fe2eadb9a375b786fda1'
  assert.deepEqual(parseArgs(['fund', '--coins', `${coin}, ${WALLET}`]), { command: 'fund', coins: [coin, WALLET] })
  for (const bad of ['', ',', '0x12', `${coin},nope`]) assert.throws(() => parseArgs(['fund', '--coins', bad]), /--coins/)
  assert.throws(() => parseArgs(['fund', '--coins', Array(51).fill(coin).join(',')]), /--coins/)
  assert.throws(() => parseArgs(['token', '--coins', coin]), /does not work with the token command/)
})

test('tickerOf and tokenMetadataArgs: the agent identity fills what was not given', () => {
  assert.equal(tickerOf(' $oobie '), 'oobie')
  for (const bad of ['', 'TWO WORDS', 'A'.repeat(33), 'X-1', undefined]) assert.throws(() => tickerOf(bad), /ticker/)
  const card = {
    name: 'Oobie',
    description: 'An agent.',
    image: 'ipfs://QmNuke1TKTWnR14mfVUxDei214xHBfdhUHFZfz7qUwv7iW',
    services: [{ name: 'web', endpoint: 'https://ubi.fun' }, { name: 'X', endpoint: 'https://x.com/ubidotfun' }, { name: 'MCP', endpoint: 'https://api.ubi.fun/mcp' }],
  }
  assert.deepEqual(tokenMetadataArgs({ name: 'Oobie', symbol: 'OOBIE', description: 'An agent.' }, card), {
    name: 'Oobie',
    symbol: 'OOBIE',
    description: 'An agent.',
    imageCid: 'QmNuke1TKTWnR14mfVUxDei214xHBfdhUHFZfz7qUwv7iW',
    website: 'https://ubi.fun',
    twitter: 'https://x.com/ubidotfun',
  })
  // --image wins over the profile image; a non-https image is refused
  assert.equal(tokenMetadataArgs({ name: 'A', symbol: 'A', description: 'B', image: 'https://e.com/a.png' }, card).imageUrl, 'https://e.com/a.png')
  assert.throws(() => tokenMetadataArgs({ name: 'A', symbol: 'A', description: 'B', image: 'http://e.com/a.png' }, card), /needs an image/)
  assert.throws(() => tokenMetadataArgs({ name: 'A', symbol: 'A', description: 'B' }, {}), /needs an image/)
  assert.throws(() => tokenMetadataArgs({ name: '', symbol: 'A', description: 'B' }, card), /name/)
  assert.throws(() => tokenMetadataArgs({ name: 'A', symbol: 'A', description: '' }, card), /description/)
  // A non-X link in the X slot is not passed on as the token's X account
  assert.equal(tokenMetadataArgs({ name: 'A', symbol: 'A', description: 'B' }, { ...card, services: [{ name: 'X', endpoint: 'https://evil.example/x' }] }).twitter, undefined)
})

test('simulatedCoin reads the first return word as the new coin address, else null', async () => {
  const coin = '0x01918708170577127007fe2eadb9a375b786fda1'
  const answer = (result) => async () => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result }) })
  const step = { to: '0xe07F0000000000000000000000000000000002834'.slice(0, 42), data: '0x12345678', value: '0' }
  assert.equal(await simulatedCoin(WALLET, step, answer(`0x${'0'.repeat(24)}${coin.slice(2)}${'0'.repeat(128)}`)), coin)
  assert.equal(await simulatedCoin(WALLET, step, answer(`0x${'0'.repeat(192)}`)), null)
  assert.equal(await simulatedCoin(WALLET, step, answer(`0x${'f'.repeat(64)}`)), null)
  assert.equal(await simulatedCoin(WALLET, step, answer(undefined)), null)
  assert.equal(await simulatedCoin(WALLET, step, async () => { throw new Error('offline') }), null)
})

test('usdcEarnings collects USDC only, with transactions it builds itself', () => {
  const usdcCoin = '0x1111111111111111111111111111111111111111'
  const vault = '0x2222222222222222222222222222222222222222'
  const earnings = {
    coins: [
      { coin: usdcCoin, status: 'vault', generation: 'v2', vault, payToken: ARC_USDC, decimals: 6, holderDividendsRaw: '250000', vaultCreditRaw: '400000' },
      // A pair-paid (v3) coin and an unread coin are left out
      { coin: '0x3333333333333333333333333333333333333333', status: 'vault', generation: 'v3', vault, payToken: '0x178b01f61CBeA1D2a5581Fe1621Be607835EC349', decimals: 18, holderDividendsRaw: '9138261032', vaultCreditRaw: '0' },
      { coin: '0x4444444444444444444444444444444444444444', status: 'unread' },
      { coin: '0x5555555555555555555555555555555555555555', status: 'no-vault' },
    ],
    creatorRevenue: { token: ARC_USDC, amountRaw: '100000' },
    // The answer's own steps are ignored
    steps: [{ to: '0x6666666666666666666666666666666666666666', data: '0xdeadbeef', value: '0' }],
  }
  const { units, steps, unread } = usdcEarnings(earnings, WALLET)
  assert.equal(units, 750_000n)
  assert.equal(unread, true)
  assert.deepEqual(steps.map((s) => [s.to, s.data, s.value]), [
    [usdcCoin, '0x6a474002', '0'],
    [vault, '0x4e71d92d', '0'],
    [FEE_ESCROW, `0x4c2d94c0${'0'.repeat(24)}${WALLET.slice(2)}${'0'.repeat(64)}`, '0'],
  ])
  assert.deepEqual(usdcEarnings({ coins: [], creatorRevenue: null }, WALLET), { units: 0n, steps: [], unread: false })
  // Junk amounts count as nothing
  assert.equal(usdcEarnings({ coins: [{ ...earnings.coins[0], holderDividendsRaw: '-5', vaultCreditRaw: '1e9' }] }, WALLET).units, 0n)
})

test('usdcPaidIn counts the USDC Transfer logs into the wallet, net, and nothing else', () => {
  const pad = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
  const word = (units) => `0x${units.toString(16).padStart(64, '0')}`
  const escrow = FEE_ESCROW
  const other = '0xec20fcf1ea879c5af2e82fc9a1c61df035155a5d'
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  // Shaped like a real FeeEscrow withdrawal on Arc (tx 0xa4dc52dd…4073): the 18-decimal native
  // system log and the 6-decimal ERC-20 log of the same transfer; only the ERC-20 one counts
  const claim = {
    logs: [
      { address: '0xfffffffffffffffffffffffffffffffffffffffe', topics: [TRANSFER, pad(escrow), pad(WALLET)], data: word(3_744_717_000_000_000_000n) },
      { address: ARC_USDC, topics: [TRANSFER, pad(escrow), pad(WALLET)], data: word(3_744_717n) },
      { address: ARC_USDC, topics: [TRANSFER, pad(escrow), pad(other)], data: word(9_000_000n) },
    ],
  }
  assert.equal(usdcPaidIn([claim], WALLET), 3_744_717n)
  const out = { logs: [{ address: ARC_USDC, topics: [TRANSFER, pad(WALLET), pad(other)], data: word(1_000_000n) }] }
  assert.equal(usdcPaidIn([claim, out], WALLET), 2_744_717n)
  // An empty claim (a second run at the same time) pays nothing
  assert.equal(usdcPaidIn([{ logs: [] }], WALLET), 0n)
  assert.equal(usdcPaidIn([out], WALLET), 0n)
})

test('sendInBatches keeps what landed before a failure, and the unconfirmed ones apart', async () => {
  const steps = Array.from({ length: 10 }, (_, i) => ({ to: WALLET, data: '0x4e71d92d', value: '0', description: `claim ${i + 1}` }))
  const ok = (step) => ({ step, txHash: `0x${String(step).padStart(64, '0')}`, explorer: `tx${step}`, status: 'confirmed' })
  const batches = []
  // The second batch: its first step lands, the second is sent but unconfirmed, then it stops
  const send = async (batch) => {
    batches.push(batch.length)
    if (batches.length === 1) return { results: batch.map((_, i) => ok(i + 1)) }
    const error = new KitError('OUTCOME_UNKNOWN', 'Circle did not finish cleanly')
    error.done = [ok(9), { step: 10, txHash: `0x${'a'.repeat(64)}`, explorer: 'tx10', status: 'unknown' }]
    throw error
  }
  const { landed, unsure, failure } = await sendInBatches(steps, send)
  assert.deepEqual(batches, [8, 2])
  assert.deepEqual(landed.map((r) => r.explorer), ['tx1', 'tx2', 'tx3', 'tx4', 'tx5', 'tx6', 'tx7', 'tx8', 'tx9'])
  assert.deepEqual(unsure.map((r) => r.explorer), ['tx10'])
  assert.equal(failure.code, 'OUTCOME_UNKNOWN')
  // A failure before anything was sent leaves nothing landed
  const none = await sendInBatches(steps, async () => { throw new KitError('SIMULATION_FAILED', 'would revert') })
  assert.deepEqual([none.landed, none.unsure, none.failure.code], [[], [], 'SIMULATION_FAILED'])
  const all = await sendInBatches(steps.slice(0, 3), async (batch) => ({ results: batch.map((_, i) => ok(i + 1)) }))
  assert.deepEqual([all.landed.length, all.unsure.length, all.failure], [3, 0, null])
})

test('depositUnits moves what the claims paid, never more than the wallet still holds', () => {
  assert.equal(depositUnits({ collected: 750_000n, balance: 9_000_000n }), 750_000n)
  assert.equal(depositUnits({ collected: 750_000n, balance: 300_000n }), 300_000n)
  assert.equal(depositUnits({ collected: 750_000n, balance: null }), 750_000n)
  // No per-run cap: all of what was collected goes
  assert.equal(depositUnits({ collected: 5_000_000_000n, balance: 6_000_000_000n }), 5_000_000_000n)
  assert.equal(usdcText(750_000n), '0.75')
  assert.equal(usdcText(1_000_000n), '1')
  assert.equal(usdcText(1_234_567n), '1.234567')
  assert.equal(gatewayAmount(usdcText(500_000n)), '0.5')
})
