import assert from 'node:assert'
import { mkdir, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, it } from 'node:test'

import {
  isAbortError,
  scanDirectoryForRepositories,
} from '../../src/lib/scan-for-repositories'
import { createTempDirectory } from '../helpers/temp'

async function createRepository(
  rootPath: string,
  segments: ReadonlyArray<string>
) {
  const repoPath = join(rootPath, ...segments)
  const headPath = join(repoPath, '.git', 'HEAD')

  await mkdir(join(repoPath, '.git'), { recursive: true })
  await writeFile(headPath, 'ref: refs/heads/main\n')

  return { repoPath, headPath }
}

async function setMtime(path: string, milliseconds: number) {
  const time = new Date(milliseconds)
  await utimes(path, time, time)
}

describe('scanDirectoryForRepositories', () => {
  it('finds repositories using glob while preserving discovery filters', async t => {
    const rootPath = await createTempDirectory(t)

    await createRepository(rootPath, [])
    const hiddenTopLevel = await createRepository(rootPath, ['.hidden-repo'])
    const visible = await createRepository(rootPath, ['visible-repo'])
    const deep = await createRepository(rootPath, [
      'workspace',
      'team',
      'deep-repo',
    ])

    await createRepository(rootPath, ['visible-repo', 'nested-repo'])
    await createRepository(rootPath, ['node_modules', 'ignored-repo'])
    await createRepository(rootPath, ['workspace', '.cache', 'ignored-repo'])

    await setMtime(hiddenTopLevel.headPath, 1_000)
    await setMtime(visible.headPath, 3_000)
    await setMtime(deep.headPath, 2_000)

    const repositories = await scanDirectoryForRepositories(rootPath, {
      maxDepth: 3,
    })

    assert.deepEqual(
      repositories.map(r => r.path),
      [visible.repoPath, deep.repoPath, hiddenTopLevel.repoPath]
    )
    assert.deepEqual(
      repositories.map(r => r.mtimeMs),
      [3_000, 2_000, 1_000]
    )
  })

  it('throws an abort error when the scan is cancelled before it starts', async t => {
    const rootPath = await createTempDirectory(t)
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      scanDirectoryForRepositories(rootPath, { signal: controller.signal }),
      isAbortError
    )
  })
})
