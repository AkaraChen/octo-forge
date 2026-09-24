import assert from 'node:assert'
import { mkdirSync, writeFileSync, type Stats } from 'fs'
import { stat as actualStat } from 'fs/promises'
import { join } from 'path'
import { describe, it, mock } from 'node:test'

import { createTempDirectory } from '../helpers/temp'

// fs.promises.stat's overload set includes a bigint return. This test and the
// scanner only call stat(path) and read Stats.mtimeMs.
type StatPath = Parameters<typeof actualStat>[0]
type StatFn = (path: StatPath) => Promise<Stats>

let statBehavior: StatFn = path => actualStat(path)

mock.module('fs/promises', {
  namedExports: {
    stat: (path: StatPath) => statBehavior(path),
  },
})

describe('scanDirectoryForRepositories cancellation during mtime lookup', () => {
  it('throws when aborted after globbing and before mtime collection completes', async t => {
    const rootPath = await createTempDirectory(t)
    const repoPath = join(rootPath, 'visible-repo')

    mkdirSync(join(repoPath, '.git'), { recursive: true })
    writeFileSync(join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const controller = new AbortController()

    statBehavior = async path => {
      const result = await actualStat(path)

      if (String(path).endsWith(`${join('.git', 'HEAD')}`)) {
        controller.abort()
      }

      return result
    }

    const { isAbortError, scanDirectoryForRepositories } = await import(
      '../../src/lib/scan-for-repositories'
    )

    await assert.rejects(
      scanDirectoryForRepositories(rootPath, {
        maxDepth: 2,
        signal: controller.signal,
      }),
      isAbortError
    )
  })
})
