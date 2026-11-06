import { describe, it } from 'vitest'
import {
  DEFAULT_CHUCK_MARGIN_MM,
  DEFAULT_ONE_PERSON_KG,
  DEFAULT_STOCK_LENGTHS_MM,
  DEFAULT_TWO_PERSON_KG,
  type PurchaseGroupInput,
  planPurchase,
  usableStockLengthMm,
} from './purchase'

const RUN = process.env.PURCHASE_BENCH === '1'
const STOCK = DEFAULT_STOCK_LENGTHS_MM
const MARGIN = DEFAULT_CHUCK_MARGIN_MM

function seeded(seed0: number): () => number {
  let seed = seed0
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

function lengths(n: number, min: number, max: number, seed: number): number[] {
  const rand = seeded(seed)
  return Array.from({ length: n }, () => min + Math.floor(rand() * (max - min)))
}

function group(pieces: number[], tee: boolean): PurchaseGroupInput {
  return {
    key: 'bench',
    stock: '200UB29.8',
    sources: [],
    tee,
    massPerMetre: 30,
    pieces: pieces.map((lengthMm, index) => ({ mark: `m${index}`, lengthMm, quantity: 1 })),
  }
}

function groupQuantity(lengthMm: number, quantity: number, tee: boolean): PurchaseGroupInput {
  return {
    key: 'bench-quantity',
    stock: '200UB29.8',
    sources: [],
    tee,
    massPerMetre: 30,
    pieces: [{ mark: 'm0', lengthMm, quantity }],
  }
}

function runPlan(input: PurchaseGroupInput) {
  return planPurchase(input, {
    stockLengthsMm: STOCK,
    marginMm: MARGIN,
    onePersonKg: DEFAULT_ONE_PERSON_KG,
    twoPersonKg: DEFAULT_TWO_PERSON_KG,
  })
}

function measure(input: PurchaseGroupInput, runs = 3) {
  for (let i = 0; i < 2; i++) runPlan(input)
  const start = performance.now()
  let plan = runPlan(input)
  for (let i = 1; i < runs; i++) plan = runPlan(input)
  return { ms: (performance.now() - start) / runs, plan }
}

function* setPartitions(items: number[]): Generator<number[][]> {
  if (items.length === 0) {
    yield []
    return
  }
  const [first, ...rest] = items
  for (const part of setPartitions(rest)) {
    for (let i = 0; i < part.length; i++) {
      const next = part.map((block, j) => (j === i ? [...block, first] : block))
      yield next
    }
    yield [[first], ...part]
  }
}

/** Exact optimum for a linear profile: enumerate every partition of the pieces. */
function exactLinear(pieces: number[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const part of setPartitions(pieces)) {
    let total = 0
    for (const block of part) {
      const used = block.reduce((sum, value) => sum + value, 0)
      const stock = STOCK.find((length) => usableStockLengthMm(length, MARGIN) >= used)
      if (stock == null) {
        total = Number.POSITIVE_INFINITY
        break
      }
      total += stock
    }
    best = Math.min(best, total)
  }
  return best
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

describe.skipIf(!RUN)('purchase benchmark', () => {
  it('small exact comparison', () => {
    console.log('\n=== A single section, exact reference (linear) ===')
    for (const n of [8, 10]) {
      let gap = 0
      let totalMs = 0
      for (let i = 0; i < 10; i++) {
        const pieces = lengths(n, 500, 12000, 1000 + n * 100 + i)
        const optimum = exactLinear(pieces)
        const result = measure(group(pieces, false), 1)
        gap += (result.plan.purchasedMm - optimum) / optimum
        totalMs += result.ms
      }
      console.log(`n=${n}: FFD gap=${pct(gap / 10)}, time=${(totalMs / 10).toFixed(1)} ms/section`)
    }
  }, 300000)

  it('one section at realistic scale', () => {
    console.log('\n=== One section, 1k / 10k pieces ===')
    const cases: [string, PurchaseGroupInput][] = [
      ['1,000 linear', group(lengths(1000, 500, 12000, 9001), false)],
      ['1,000 T', group(lengths(1000, 1500, 3000, 9002), true)],
      ['10,000 linear', group(lengths(10000, 500, 12000, 9003), false)],
      ['10,000 T', group(lengths(10000, 1500, 3000, 9004), true)],
      ['quantity 10,000 linear', groupQuantity(2000, 10000, false)],
      ['quantity 10,000 T', groupQuantity(2000, 10000, true)],
    ]
    for (const [label, input] of cases) {
      const result = measure(input, 2)
      const pieces = input.pieces.reduce((sum, piece) => sum + piece.quantity, 0)
      console.log(
        `${label}: ${pieces} pieces → ${result.plan.purchasedMm.toFixed(0)} mm in ${result.ms.toFixed(1)} ms`,
      )
    }
  }, 600000)
})
