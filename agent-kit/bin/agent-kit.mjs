#!/usr/bin/env node
import { main } from '../lib/kit.mjs'

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`\n${error.code ? `${error.code}: ` : ''}${error.message}\n`)
  process.exitCode = 1
})
