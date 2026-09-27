import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { RUNTIME_ANCHORS, STATIC_ANCHORS, findMissingAnchors, isRegularFile } from './anchor-contract.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontendRoot = resolve(projectRoot, 'node_modules/@deepseek-ai/dsh-web-frontend/dist')

test('findMissingAnchors reports only the anchors absent from the corpus', () => {
  const anchors = [
    { token: 'present-token', purpose: '示例：存在的锚点' },
    { token: 'absent-token', purpose: '示例：缺失的锚点' },
  ]
  assert.deepEqual(findMissingAnchors(anchors, 'a string with present-token inside'), [anchors[1]])
  assert.deepEqual(findMissingAnchors(anchors, 'present-token and absent-token'), [])
})

test('the runtime anchor guard fails and names the affected rules when anchors disappear', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-fail-'))
  try {
    const plugin = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib')
    await mkdir(plugin, { recursive: true })
    await writeFile(join(plugin, 'client.js'), 'const empty = "no anchors here";\n', 'utf8')
    const result = await promisify(execFile)(process.execPath, ['scripts/check-runtime-anchors.mjs', root], {
      cwd: projectRoot,
    }).then(() => null, error => error)
    assert.ok(result, '缺少锚点的运行时目录必须让检查失败')
    assert.equal(result.code, 1)
    for (const anchor of RUNTIME_ANCHORS) {
      assert.match(result.stderr, new RegExp(anchor.token.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&')))
    }
    assert.match(result.stderr, /android\.css/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the runtime anchor guard passes when the plugin tree carries every anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-pass-'))
  try {
    const plugin = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib')
    await mkdir(plugin, { recursive: true })
    const body = RUNTIME_ANCHORS.map(anchor => `"${anchor.token}"`).join(', ')
    await writeFile(join(plugin, 'client.js'), `const anchors = [${body}];\n`, 'utf8')
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/check-runtime-anchors.mjs', root], {
      cwd: projectRoot,
    })
    assert.match(stdout, /运行时锚点契约完整/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the installed official frontend still carries every static anchor', async () => {
  const chunks = []
  for (const entry of await readdir(frontendRoot, { recursive: true, withFileTypes: true })) {
    if (!/\.(?:css|js)$/u.test(entry.name)) continue
    const fullPath = resolve(entry.parentPath, entry.name)
    if (!await isRegularFile(entry, fullPath, lstat)) continue
    chunks.push(await readFile(fullPath, 'utf8'))
  }
  assert.deepEqual(findMissingAnchors(STATIC_ANCHORS, chunks.join('\n')), [])
})

test('isRegularFile falls back to lstat when d_type is unknown', async () => {
  const yes = { isFile: () => true }
  assert.equal(await isRegularFile(yes, '/x', () => { throw new Error('must not stat') }), true)
  const unknownFile = { isFile: () => false }
  assert.equal(await isRegularFile(unknownFile, '/f', async () => ({ isFile: () => true, isSymbolicLink: () => false })), true)
  assert.equal(await isRegularFile(unknownFile, '/d', async () => ({ isFile: () => false, isSymbolicLink: () => false })), false)
  // 损坏的 d_type 会把常规文件报成符号链接：不能信反向判定，必须以 lstat 为准。
  const lyingLink = { isFile: () => false, isSymbolicLink: () => true }
  assert.equal(await isRegularFile(lyingLink, '/f', async () => ({ isFile: () => true, isSymbolicLink: () => false })), true)
  assert.equal(await isRegularFile(lyingLink, '/l', async () => ({ isFile: () => false, isSymbolicLink: () => true })), false)
  assert.equal(await isRegularFile(unknownFile, '/gone', async () => { throw new Error('ENOENT') }), false)
})
