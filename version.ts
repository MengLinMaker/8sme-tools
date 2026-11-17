import { execFileSync } from 'node:child_process'

/**
 * Build label shown under the app title: short commit hash, `-dirty` for uncommitted local work,
 * then the commit date — e.g. `4f47b68-dirty-2026-11-17`.
 *
 * The hash comes from the CI environment first — Cloudflare checks the repo out and then runs
 * tooling in it, so `git status` there can report changes on a pristine tree and every deploy
 * would be labelled `-dirty`. Only a local build trusts the working-tree check.
 */

/** Commit hash env vars set by the CI platforms this app is built on, in order of preference. */
const CI_COMMIT_VARS = [
  'WORKERS_CI_COMMIT_SHA',
  'CF_PAGES_COMMIT_SHA',
  'GITHUB_SHA',
  'CI_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
] as const

const CI_MARKERS = ['CI', 'WORKERS_CI', 'CF_PAGES', 'GITHUB_ACTIONS', 'VERCEL'] as const

const SHORT_HASH_LENGTH = 7

function git(...args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** `YYYY-MM-DD` for today (UTC) — only used when the commit date cannot be read. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export function buildVersion(): string {
  const ciHash = CI_COMMIT_VARS.map((name) => process.env[name]).find(
    (value): value is string => typeof value === 'string' && value.length >= SHORT_HASH_LENGTH,
  )

  const hash = (ciHash?.slice(0, SHORT_HASH_LENGTH) ?? git('rev-parse', '--short', 'HEAD')) || 'dev'
  // Commit date keeps the label stable for a rebuilt commit; fall back to today when git is absent.
  const date = git('show', '-s', '--format=%cs', 'HEAD') ?? todayUtc()

  const inCi = Boolean(ciHash) || CI_MARKERS.some((name) => process.env[name])
  const dirty = !inCi && git('status', '--porcelain') !== null

  return `${hash}${dirty ? '-dirty' : ''}-${date}`
}
