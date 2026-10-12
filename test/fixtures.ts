import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repo-local test fixtures: real job parts (DSTV `.nc1` + AP214 `.stp`) live under `test/fixtures/`
 * beside the suites that read them — never an absolute `~/Downloads` path. Every fixture test
 * skips when its files are absent, so the suite stays green on a bare checkout; CI checks the
 * files in. Point `SME_FIXTURES_DIR` elsewhere to run against an out-of-band dataset.
 */
export const FIXTURES_DIR =
  process.env.SME_FIXTURES_DIR ?? fileURLToPath(new URL('./fixtures', import.meta.url))

/** Scratch output for tests that render or emit files. Git-ignored; override with `SME_OUTPUT_DIR`. */
export const OUTPUT_DIR =
  process.env.SME_OUTPUT_DIR ?? fileURLToPath(new URL('./.out', import.meta.url))

/** Resolve a path inside the fixture tree, e.g. `fixture('nw31-bottom', 'm128.nc1')`. */
export function fixture(...segments: string[]): string {
  return join(FIXTURES_DIR, ...segments)
}

export function fixtureExists(...segments: string[]): boolean {
  return existsSync(fixture(...segments))
}

/** `11601-02-01 NW30 BOTTOM FRAMES - SHAFTS` — flat `m###.nc1` / `m###.stp`. */
export const nw30Bottom = (...segments: string[]): string => fixture('nw30-bottom', ...segments)

/** `11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts` — flat `m###.nc1` / `m###.stp`. */
export const nw31Bottom = (...segments: string[]): string => fixture('nw31-bottom', ...segments)

/** `11602-03-01 (NW31 Top frames) Shaft part drawings` — `NC files/` + `STP files/` sub-dirs. */
export const nw31Top = (...segments: string[]): string => fixture('nw31-top', ...segments)
