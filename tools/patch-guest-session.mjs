#!/usr/bin/env node
/**
 * Persistent session partition for DSH Desktop's webview guests.
 *
 * `DesktopBrowserGuests.acquire()` builds `dsh-sidebar-browser-${randomUUID()}` and
 * hands it to `session.fromPartition()`. Without the `persist:` prefix that is an
 * in-memory session, so every DSH launch starts with empty cookies, localStorage
 * and IndexedDB. This rewrites that one expression to a workspace-derived,
 * `persist:`-prefixed name; every other file is copied byte-for-byte and the
 * archive is re-verified after writing.
 *
 * The plugin's in-page console (Eruda) needs no host patch — it is injected into
 * the guest document itself.
 *
 *   node tools/patch-guest-session.mjs status
 *   node tools/patch-guest-session.mjs apply
 *   node tools/patch-guest-session.mjs revert
 *
 * If DSH is running, Windows may refuse the replace; the patched archive is then
 * staged as `app.asar.patched` and `apply --commit` finishes the job after DSH quits.
 */
import {
  closeSync, copyFileSync, existsSync, openSync, readSync, renameSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs'

const DEFAULT_ARCHIVE = 'D:\\DeepSeek Harness\\resources\\app.asar'

/**
 * Every entry rewrites exactly one guarded expression in lib/main.js.
 * `marker` is what status/verify look for, so each rewrite must introduce a
 * string no other line of main.js can contain.
 */
const PATCHES = [
  {
    id: 'partition',
    label: 'guest session partition',
    from: 'partition = `dsh-sidebar-browser-${randomUUID()}`;',
    to: 'partition = `persist:dsh-browser-${Buffer.from(workspace).toString(\'base64url\').slice(0, 24)}`;',
    marker: 'persist:dsh-browser-',
  },
]

const align4 = value => Math.ceil(value / 4) * 4
const isStored = node => node.unpacked !== true && node.link === undefined && Number(node.size) > 0

function parseArgs(argv) {
  const out = { command: argv[2] ?? 'status', archive: DEFAULT_ARCHIVE, commit: false }
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--archive') out.archive = argv[++i]
    else if (argv[i] === '--commit') out.commit = true
  }
  return out
}

function readHeader(archive) {
  const fd = openSync(archive, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    readSync(fd, sizeBuf, 0, 8, 0)
    if (sizeBuf.readUInt32LE(0) !== 4) throw new Error('not an asar archive: bad leading pickle')
    const headerPickleSize = sizeBuf.readUInt32LE(4)
    const pickle = Buffer.alloc(headerPickleSize)
    readSync(fd, pickle, 0, headerPickleSize, 8)
    const stringLen = pickle.readUInt32LE(4)
    if (8 + stringLen > pickle.length) throw new Error('not an asar archive: header overruns its pickle')
    return { json: pickle.subarray(8, 8 + stringLen).toString('utf8'), dataStart: 8 + headerPickleSize }
  } finally {
    closeSync(fd)
  }
}

function readFileRange(archive, start, length) {
  const fd = openSync(archive, 'r')
  try {
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const got = readSync(fd, buf, read, length - read, start + read)
      if (got === 0) break
      read += got
    }
    return read === length ? buf : buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function collectFiles(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (value.files) walk(value, path)
      else out.push({ path, node: value })
    }
  }
  walk(header, '')
  return out
}

function loadArchive(archive) {
  const head = readHeader(archive)
  const header = JSON.parse(head.json)
  const entries = collectFiles(header)
  const main = entries.find(entry => entry.path === 'lib/main.js')
  if (!main) throw new Error('lib/main.js is missing from the archive')
  const mainText = readFileRange(
    archive,
    head.dataStart + Number(main.node.offset),
    Number(main.node.size),
  ).toString('utf8')
  return { head, header, entries, main, mainText, total: statSync(archive).size }
}

function encodeHeader(json) {
  const stringLen = json.length
  const padded = align4(stringLen)
  // Layout matched by readHeader(): [uint32 4][uint32 pickleSize][uint32 payloadSize][uint32 stringLen][json][pad]
  const payloadSize = 4 + padded
  const pickleSize = 4 + payloadSize
  const area = Buffer.alloc(8 + pickleSize)
  area.writeUInt32LE(4, 0)
  area.writeUInt32LE(pickleSize, 4)
  area.writeUInt32LE(payloadSize, 8)
  area.writeUInt32LE(stringLen, 12)
  json.copy(area, 16)
  return area
}

function verifyArchive(archive, expectedMain) {
  const { head, entries, mainText, total } = loadArchive(archive)
  for (const entry of entries) {
    if (!isStored(entry.node)) continue
    const end = Number(entry.node.offset) + Number(entry.node.size)
    if (end > total - head.dataStart) throw new Error(`verify: ${entry.path} overruns the data area`)
  }
  if (expectedMain !== undefined && mainText !== expectedMain) {
    throw new Error('verify: patched main.js does not read back identically')
  }
  const missing = PATCHES.filter(patch => !mainText.includes(patch.marker))
  if (missing.length > 0) {
    throw new Error(`verify: missing patch markers for ${missing.map(patch => patch.id).join(', ')}`)
  }
  return entries.length
}

function buildPatched(archive) {
  const { head, header, entries, main, mainText } = loadArchive(archive)
  const present = PATCHES.filter(patch => mainText.includes(patch.marker))
  if (present.length === PATCHES.length) throw new Error('main.js is already patched')

  let patchedText = mainText
  for (const patch of PATCHES) {
    if (patchedText.includes(patch.marker)) continue
    const hits = patchedText.split(patch.from).length - 1
    if (hits !== 1) throw new Error(`expected exactly one "${patch.id}" expression, found ${hits}`)
    patchedText = patchedText.replace(patch.from, patch.to)
  }

  const patchedBuf = Buffer.from(patchedText, 'utf8')
  const sourceOffsets = new Map(entries.map(entry => [entry.path, Number(entry.node.offset)]))

  main.node.size = patchedBuf.length
  delete main.node.integrity

  let cursor = 0
  for (const entry of entries) {
    if (!isStored(entry.node)) continue
    entry.node.offset = String(cursor)
    cursor = align4(cursor + Number(entry.node.size))
  }

  const headerArea = encodeHeader(Buffer.from(JSON.stringify(header), 'utf8'))
  const staging = `${archive}.patched`
  if (existsSync(staging)) unlinkSync(staging)

  const outFd = openSync(staging, 'w')
  try {
    writeSync(outFd, headerArea, 0, headerArea.length)
    let written = headerArea.length
    for (const entry of entries) {
      if (!isStored(entry.node)) continue
      const absolute = headerArea.length + Number(entry.node.offset)
      if (written < absolute) {
        writeSync(outFd, Buffer.alloc(absolute - written))
        written = absolute
      }
      const size = Number(entry.node.size)
      const bytes = entry.path === 'lib/main.js'
        ? patchedBuf
        : readFileRange(archive, head.dataStart + (sourceOffsets.get(entry.path) ?? 0), size)
      writeSync(outFd, bytes, 0, bytes.length)
      written += bytes.length
    }
  } finally {
    closeSync(outFd)
  }

  verifyArchive(staging, patchedText)
  return { staging, patchedText }
}

function apply(archive) {
  const backup = `${archive}.orig`
  if (existsSync(backup)) console.log(`backup:  ${backup} (kept from a previous run)`)
  else { copyFileSync(archive, backup); console.log(`backup:  ${backup}`) }

  const { staging } = buildPatched(archive)
  console.log(`built:   ${staging}`)

  try {
    renameSync(staging, archive)
    console.log(`applied: ${archive}`)
    console.log('restart DSH Desktop, sign in once, and the guest session will survive restarts.')
    return true
  } catch (error) {
    console.log(`replace refused (${error.code ?? error.message}) — DSH is probably running.`)
    console.log('quit DSH Desktop, then run:')
    console.log(`  node tools/patch-guest-session.mjs apply --archive "${archive}" --commit`)
    return false
  }
}

function commit(archive) {
  const staging = `${archive}.patched`
  if (!existsSync(staging)) throw new Error(`nothing staged at ${staging}`)
  verifyArchive(staging)
  renameSync(staging, archive)
  console.log(`committed: ${archive}`)
  return true
}

function revert(archive) {
  const backup = `${archive}.orig`
  if (!existsSync(backup)) throw new Error(`no backup at ${backup}`)
  const staging = `${archive}.patched`
  if (existsSync(staging)) unlinkSync(staging)
  renameSync(backup, archive)
  console.log(`reverted: ${archive}`)
  return true
}

const args = parseArgs(process.argv)
if (!existsSync(args.archive)) {
  console.error(`archive not found: ${args.archive}`)
  process.exit(2)
}

try {
  if (args.command === 'status') {
    const { head, entries, mainText, total } = loadArchive(args.archive)
    console.log(`archive: ${args.archive}`)
    console.log(`layout:  ${entries.length} entries, ${total} bytes, data at ${head.dataStart}`)
    for (const patch of PATCHES) {
      const done = mainText.includes(patch.marker)
      console.log(`  ${done ? '[x]' : '[ ]'} ${patch.id.padEnd(10)} ${patch.label}`)
    }
    const done = PATCHES.filter(patch => mainText.includes(patch.marker)).length
    console.log(`state:   ${done === PATCHES.length ? 'patched' : done === 0 ? 'stock' : 'partially patched'}`)
  } else if (args.command === 'apply') {
    if (args.commit) commit(args.archive)
    else apply(args.archive)
  } else if (args.command === 'revert') {
    revert(args.archive)
  } else {
    console.error('usage: node tools/patch-guest-session.mjs <status|apply|revert> [--archive PATH] [--commit]')
    process.exit(2)
  }
} catch (error) {
  console.error(`failed: ${error.message}`)
  process.exit(1)
}
