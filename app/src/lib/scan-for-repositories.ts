import { stat } from 'fs/promises'
import glob from 'glob'
import { dirname, join } from 'path'

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

const createAbortError = () => {
  const err = new Error('Scan aborted')
  err.name = 'AbortError'
  return err
}

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) {
    throw createAbortError()
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

function getRepositoryGlobPatterns(maxDepth: number): ReadonlyArray<string> {
  return Array.from(
    { length: maxDepth },
    (_, index) => `${getWildcardPath(index + 1)}/.git`
  )
}

function getPathSegments(path: string): ReadonlyArray<string> {
  return path.split(/[\\/]/)
}

function getWildcardPath(depth: number): string {
  return new Array(depth).fill('*').join('/')
}

function shouldIncludeRepositoryPath(relativePath: string): boolean {
  const segments = getPathSegments(relativePath)

  return segments.every(
    (segment, index) =>
      !SKIP_DIRECTORY_NAMES.has(segment) &&
      (index === 0 || !segment.startsWith('.'))
  )
}

function filterNestedRepositories(
  relativePaths: ReadonlyArray<string>
): ReadonlyArray<string> {
  const keptPaths = new Array<ReadonlyArray<string>>()
  const nonNestedPaths = new Array<string>()

  const sorted = [...relativePaths].sort((a, b) => {
    const depthDifference =
      getPathSegments(a).length - getPathSegments(b).length
    return depthDifference !== 0 ? depthDifference : a.localeCompare(b)
  })

  for (const relativePath of sorted) {
    const segments = getPathSegments(relativePath)
    const nested = keptPaths.some(
      parent =>
        parent.length < segments.length &&
        parent.every((segment, index) => segment === segments[index])
    )

    if (nested) {
      continue
    }

    nonNestedPaths.push(relativePath)
    keptPaths.push(segments)
  }

  return nonNestedPaths
}

async function globMatches(
  pattern: string,
  cwd: string,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<string>> {
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError())

    signal?.addEventListener('abort', onAbort, { once: true })

    glob(
      pattern,
      { cwd, dot: true, nosort: true, silent: true, strict: false },
      (err, matches) => {
        signal?.removeEventListener('abort', onAbort)

        if (signal?.aborted) {
          reject(createAbortError())
          return
        }

        if (err !== null) {
          reject(err)
          return
        }

        resolve(matches)
      }
    )
  })
}

export async function scanDirectoryForRepositories(
  rootPath: string,
  options?: IScanOptions
): Promise<ReadonlyArray<IDiscoveredRepository>> {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH
  const signal = options?.signal

  const matchedGitEntries = await Promise.all(
    getRepositoryGlobPatterns(maxDepth).map(pattern =>
      globMatches(pattern, rootPath, signal)
    )
  )

  const relativePaths = filterNestedRepositories(
    [
      ...new Set(matchedGitEntries.flatMap(matches => matches.map(dirname))),
    ].filter(shouldIncludeRepositoryPath)
  )

  const paths = relativePaths.map(relativePath => join(rootPath, relativePath))
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
