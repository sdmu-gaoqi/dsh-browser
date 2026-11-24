// Deep-compare a patched app.asar against its original: every stored file must
// match byte-for-byte except lib/main.js, and that one must differ only by the
// partition expression.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'

const original = process.argv[2]
const patched = process.argv[3]
const TARGET = 'lib/main.js'

function readHeader(archive) {
  const fd = openSync(archive, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    readSync(fd, sizeBuf, 0, 8, 0)
    const headerPickleSize = sizeBuf.readUInt32LE(4)
    const pickle = Buffer.alloc(headerPickleSize)
    readSync(fd, pickle, 0, headerPickleSize, 8)
    const stringLen = pickle.readUInt32LE(4)
    return { json: pickle.subarray(8, 8 + stringLen).toString('utf8'), dataStart: 8 + headerPickleSize, headerPickleSize }
  } finally {
    closeSync(fd)
  }
}

function collect(archive) {
  const head = readHeader(archive)
  const header = JSON.parse(head.json)
  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (value.files) { walk(value, path); continue }
      if (value.unpacked === true || value.link !== undefined) continue
      files.set(path, { offset: Number(value.offset), size: Number(value.size) })
    }
  }
  walk(header, '')
  return { head, files }
}

function hashRange(archive, start, length) {
  const fd = openSync(archive, 'r')
  try {
    const chunk = Buffer.alloc(1024 * 1024)
    const hash = createHash('sha256')
    let read = 0
    while (read < length) {
      const got = readSync(fd, chunk, 0, Math.min(chunk.length, length - read), start + read)
      if (got === 0) break
      hash.update(chunk.subarray(0, got))
      read += got
    }
    return { hash: hash.digest('hex'), read }
  } finally {
    closeSync(fd)
  }
}

const a = collect(original)
const b = collect(patched)
console.log(`original: ${statSync(original).size} bytes, header ${a.head.headerPickleSize}, ${a.files.size} files`)
console.log(`patched:  ${statSync(patched).size} bytes, header ${b.head.headerPickleSize}, ${b.files.size} files`)

let missing = 0
let mismatched = 0
const changed = []
for (const [path, file] of a.files) {
  const other = b.files.get(path)
  if (!other) { missing += 1; console.log(`missing in patched: ${path}`); continue }
  const one = hashRange(original, a.head.dataStart + file.offset, file.size)
  const two = hashRange(patched, b.head.dataStart + other.offset, other.size)
  if (one.read !== file.size || two.read !== other.size) { mismatched += 1; console.log(`short read: ${path}`); continue }
  if (one.hash !== two.hash) { mismatched += 1; changed.push(path) }
}
for (const path of b.files.keys()) if (!a.files.has(path)) { missing += 1; console.log(`extra in patched: ${path}`) }

console.log(`\nidentical: ${a.files.size - mismatched - missing - changed.length}`)
console.log(`extra/missing: ${missing}`)
console.log(`changed: ${changed.length} ${JSON.stringify(changed.slice(0, 5))}`)
if (changed.length === 1 && changed[0] === TARGET) {
  const one = a.files.get(TARGET)
  const two = b.files.get(TARGET)
  console.log(`target size: ${one.size} -> ${two.size} (${two.size - one.size >= 0 ? '+' : ''}${two.size - one.size})`)
  console.log('RESULT: only lib/main.js changed — patch is structurally clean')
} else {
  console.log('RESULT: unexpected file changes — investigate before committing')
  process.exitCode = 1
}
