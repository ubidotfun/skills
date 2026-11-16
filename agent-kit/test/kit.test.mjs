import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { agentIdFromLogs, agentIdsHeld, callTool, HELP, KitError, main, normalizeX, parseArgs, profileArgs, REGISTRY } from '../lib/kit.mjs'

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
