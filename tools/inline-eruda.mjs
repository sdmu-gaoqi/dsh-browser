#!/usr/bin/env node
/**
 * Refresh the Eruda payload inlined in client.js.
 *
 *   node tools/inline-eruda.mjs                  # pinned release
 *   node tools/inline-eruda.mjs --version 3.5.0  # another release
 *
 * The bundle is fetched into memory and written straight into the
 * `const ERUDA_SOURCE = "…";` literal, so no copy has to live in the repo.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PINNED = '3.4.1'
const flag = process.argv.indexOf('--version')
const version = flag >= 0 ? process.argv[flag + 1] : PINNED
if (!version) throw new Error('--version needs a value')

const url = `https://cdn.jsdelivr.net/npm/eruda@${version}/eruda.min.js`
const response = await fetch(url)
if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
const source = (await response.text()).replace(/^\uFEFF/, '')
if (source.length < 100000 || !source.includes('eruda')) {
  throw new Error(`unexpected eruda bundle from ${url}: ${source.length} bytes`)
}

const clientPath = new URL('../client.js', import.meta.url)
const client = readFileSync(clientPath, 'utf8')

const key = 'const ERUDA_SOURCE = '
const at = client.indexOf(key)
if (at < 0) throw new Error(`missing ${key.trim()} in client.js`)
const quote = at + key.length
if (client[quote] !== '"') throw new Error('ERUDA_SOURCE is not a JSON string literal')

// Walk the JSON string by hand so escapes cannot terminate it early.
let end = quote + 1
while (end < client.length) {
  if (client[end] === '\\') { end += 2; continue }
  if (client[end] === '"') break
  end += 1
}
if (end >= client.length) throw new Error('unterminated ERUDA_SOURCE literal')

const next = `${client.slice(0, quote)}${JSON.stringify(source)}${client.slice(end + 1)}`
writeFileSync(clientPath, next, 'utf8')
console.log(`eruda ${version}: ${source.length} bytes inlined (client.js ${client.length} -> ${next.length})`)
