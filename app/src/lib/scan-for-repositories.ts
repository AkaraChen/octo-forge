import { readdir, stat } from 'fs/promises'
import { join } from 'path'

export interface IScanOptions {
  readonly maxDepth?: number
  readonly signal?: AbortSignal
}

export interface IDiscoveredRepository {
  readonly path: string
  /**
   * The "last modified" time used for ordering. Prefers the mtime of
   * `.git/HEAD` because git rewrites it on virtually every operation
   * (checkout/commit/fetch). Falls back to the repo directory's own mtime
   * when HEAD can't be stat'd.
   */
  readonly mtimeMs: number
}

const DEFAULT_MAX_DEPTH = 6

const SKIP_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  'Pods',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
])

const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'AbortError'

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) {
    const err = new Error('Scan aborted')
    err.name = 'AbortError'
    throw err
  }
}

async function getRepoMtime(repoPath: string): Promise<number> {
  try {
    const s = await stat(join(repoPath, '.git', 'HEAD'))
    return s.mtimeMs
  } catch {
    try {
      const s = await stat(repoPath)
      return s.mtimeMs
    } catch {
      return 0
    }
  }
}

export async function scanDirectoryForRepositories(
  rootPath: string,
  options?: IScanOptions
): Promise<ReadonlyArray<IDiscoveredRepository>> {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH
  const signal = options?.signal

  const found = new Set<string>()

  const walk = async (dir: string, depth: number): Promise<void> => {
    throwIfAborted(signal)

    if (depth > maxDepth) {
      return
    }

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err: any) {
      if (
        err?.code === 'EACCES' ||
        err?.code === 'EPERM' ||
        err?.code === 'ENOENT' ||
        err?.code === 'ENOTDIR'
      ) {
        return
      }
      throw err
    }

    // The user-selected root is a container, never a result — even if it
    // happens to be a git repo itself we want to scan everything inside it.
    const isRoot = depth === 0
    const hasGitEntry = entries.some(e => e.name === '.git')

    if (hasGitEntry && !isRoot) {
      found.add(dir)
      return
    }

    for (const entry of entries) {
      throwIfAborted(signal)

      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue
      }

      if (SKIP_DIRECTORY_NAMES.has(entry.name)) {
        continue
      }

      // Skip hidden directories only below the root. The root was picked
      // explicitly by the user; deeper hidden dirs are usually noise
      // (`.cache`, `.npm`, `.local`, …).
      if (!isRoot && entry.name.startsWith('.')) {
        continue
      }

      await walk(join(dir, entry.name), depth + 1)
    }
  }

  await walk(rootPath, 0)

  const paths = [...found]
  const withMtime = await Promise.all(
    paths.map(async path => ({ path, mtimeMs: await getRepoMtime(path) }))
  )

  // Most recently modified first; tiebreak by path for determinism.
  withMtime.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs
    }
    return a.path.localeCompare(b.path)
  })

  return withMtime
}

export { isAbortError }
