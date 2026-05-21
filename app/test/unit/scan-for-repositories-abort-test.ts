import assert from 'node:assert'
import { stat as actualStat } from 'fs/promises'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, it, mock } from 'node:test'

import { createTempDirectory } from '../helpers/temp'

type TStat = typeof actualStat

let statBehavior: TStat = path => actualStat(path)

mock.module('fs/promises', {
  exports: {
    stat: (path: Parameters<TStat>[0]) => statBehavior(path),
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
