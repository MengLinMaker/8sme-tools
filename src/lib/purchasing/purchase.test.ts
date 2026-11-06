import { describe, expect, it } from 'vitest'
import {
  AU_STOCK_LENGTHS_MM,
  DEFAULT_CHUCK_MARGIN_MM,
  DEFAULT_STOCK_LENGTHS_MM,
  marginForStockLength,
  type PurchaseGroupInput,
  planPurchase,
  stockLengthsForStock,
} from './purchase'

const STOCK = DEFAULT_STOCK_LENGTHS_MM

function group(
  pieces: [number, number][],
  tee = false,
  massPerMetre: number | null = null,
): PurchaseGroupInput {
  return {
    key: tee ? 'tee:200UB29.8' : 'profile:200UB29.8',
    stock: '200UB29.8',
    sources: ['BT100*15'],
    tee,
    massPerMetre,
    pieces: pieces.map(([lengthMm, quantity], index) => ({
      mark: `m${index}`,
      lengthMm,
      quantity,
    })),
  }
}

describe('marginForStockLength', () => {
  it('doubles the allowance only when the bar must be cut in half', () => {
    expect(marginForStockLength(13500, 150)).toBe(150)
    expect(marginForStockLength(16500, 150)).toBe(300)
    expect(marginForStockLength(20000, 100)).toBe(200)
  })
})

describe('stockLengthsForStock', () => {
  it('uses the supplier lengths for each section family', () => {
    expect(stockLengthsForStock('200UB29.8')).toEqual([
      9000, 10500, 12000, 13500, 15000, 16500, 18000, 20000,
    ])
    expect(stockLengthsForStock('RHS100*50*3.0')).toEqual([8000, 12000])
    expect(stockLengthsForStock('SHS100*100*6.0')).toEqual([8000, 12000])
    expect(stockLengthsForStock('EA50*50*5')).toEqual([6000, 9000, 12000])
    expect(stockLengthsForStock('CHS100*3.2')).toEqual([6000, 9000])
  })
})

describe('planPurchase', () => {
  it('uses the shortest stock that fits after reserving the chuck margin', () => {
    const plan = planPurchase(group([[3000, 2]]), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // Two 3 m pieces need 6 m, but 6 m less 150 mm cannot hold both.
    expect(plan.purchases).toEqual([{ lengthMm: 9000, count: 1 }])
    expect(plan.wasteMm).toBe(3000)
  })

  it('prefers one long bar over several short ones when it buys less material', () => {
    const plan = planPurchase(group([[4000, 3]]), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // Three 4 m pieces need 13.5 m; 2 x 12 m would buy 24 m.
    expect(plan.purchases).toEqual([{ lengthMm: 13500, count: 1 }])
    expect(plan.purchasedMm).toBe(13500)
  })

  it('shrinks packed bars to a smaller standard length when it fits', () => {
    const plan = planPurchase(group([[3000, 5]]), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // 3 x 3 m fills a 10.5 m bar and 2 x 3 m goes on a 9 m bar: 19.5 m total.
    expect(plan.purchases).toEqual([
      { lengthMm: 9000, count: 1 },
      { lengthMm: 10500, count: 1 },
    ])
    expect(plan.purchasedMm).toBe(19500)
  })

  it('pairs T bars so one parent UB supplies two T pieces', () => {
    const plan = planPurchase(group([[4000, 2]], true), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // Two T bars come from one 9 m UB, not two.
    expect(plan.purchases).toEqual([{ lengthMm: 9000, count: 1 }])
    expect(plan.bars).toHaveLength(2)
    // Both sides of the UB are usable, so the two 4 m T's use 8 m of capacity.
    expect(plan.utilisation).toBeCloseTo(8000 / 18000)
  })

  it('pairs the largest T bars first to keep the parent beams short', () => {
    const plan = planPurchase(
      group(
        [
          [10000, 1],
          [1000, 1],
        ],
        true,
      ),
      {
        stockLengthsMm: STOCK,
        marginMm: DEFAULT_CHUCK_MARGIN_MM,
      },
    )
    // Largest with largest would give 10.5 m; pairing 10 m with 1 m avoids a second huge bar.
    expect(plan.purchases).toEqual([{ lengthMm: 10500, count: 1 }])
  })

  it('reports pieces longer than every available stock length', () => {
    const plan = planPurchase(group([[14000, 1]]), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    expect(plan.oversized).toHaveLength(1)
    expect(plan.purchases).toHaveLength(0)
  })

  it('can use supplier lengths beyond the machine single pass when selected', () => {
    const plan = planPurchase(group([[8000, 2]], false, 30), {
      stockLengthsMm: AU_STOCK_LENGTHS_MM,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // Two 8 m pieces fit one 16.5 m bar, which must be cut down before loading.
    expect(plan.purchases).toEqual([{ lengthMm: 16500, count: 1 }])
    expect(plan.loadingOnePersonMoves).toBe(0)
    expect(plan.loadingTwoPersonMoves).toBe(0)
    // Cut in half before machining -> two equipment loads.
    expect(plan.loadingEquipmentMoves).toBe(2)
  })

  it('classifies loading by the full beam weight', () => {
    const light = planPurchase(group([[8000, 1]], false, 2.5), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // 9 m beam x 2.5 kg/m = 22.5 kg -> one person.
    expect(light.loadingOnePersonMoves).toBe(1)

    const two = planPurchase(group([[8000, 1]], false, 4), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // 9 m beam x 4 kg/m = 36 kg -> two people.
    expect(two.loadingTwoPersonMoves).toBe(1)

    const equipment = planPurchase(group([[8000, 1]], false, 10), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // 9 m beam x 10 kg/m = 90 kg -> equipment.
    expect(equipment.loadingEquipmentMoves).toBe(1)
  })

  it('doubles the chuck allowance when the stock must be cut in half', () => {
    const plan = planPurchase(
      group([
        [8250, 1],
        [8000, 1],
      ]),
      {
        stockLengthsMm: [...DEFAULT_STOCK_LENGTHS_MM, 16500],
        marginMm: DEFAULT_CHUCK_MARGIN_MM,
      },
    )
    // 16.25 m fits a 16.5 m bar with one margin but not with the doubled margin (16.2 m).
    expect(plan.purchases).toEqual([{ lengthMm: 9000, count: 2 }])
    expect(plan.purchasedMm).toBe(18000)
  })

  it('splits offcuts into bin waste (<2 m) and reusable stock', () => {
    const reusable = planPurchase(group([[4000, 1]], false, 100), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    expect(reusable.reusableOffcutMm).toBe(5000)
    expect(reusable.reusableOffcutKg).toBeCloseTo(500)
    expect(reusable.binWasteMm).toBe(0)

    const bin = planPurchase(group([[8500, 1]], false, 100), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    expect(bin.binWasteMm).toBe(500)
    expect(bin.binWasteKg).toBeCloseTo(50)
    expect(bin.reusableOffcutMm).toBe(0)

    const light = planPurchase(group([[8800, 1]], false, 100), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    expect(light.binWasteKg).toBeCloseTo(20)
    expect(light.carryOnePieces).toBe(1)
  })

  it('weights a T offcut with half the parent UB mass', () => {
    const plan = planPurchase(group([[4000, 2]], true, 100), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    expect(plan.carryOnePieces).toBe(0)
    expect(plan.carryTwoPieces).toBe(1)
    expect(plan.overTwoPieces).toBe(1)
    expect(plan.wasteKg).toBeCloseTo(500)
    expect(plan.purchasedKg).toBeCloseTo(900)
  })

  it('minimises purchased length, which is the purchased weight', () => {
    const plan = planPurchase(group([[5500, 2]], false, 100), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    expect(plan.purchasedMm).toBe(12000)
    expect(plan.wasteKg).toBeCloseTo(100)
  })

  it('flags a bar whose last piece starts inside the support zone', () => {
    const plan = planPurchase(group([[1000, 8]], false, 30), {
      stockLengthsMm: [9000],
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // 8 x 1 m on a 9 m bar: the last 1 m piece starts at 7 m, inside the 7–9 m zone.
    expect(plan.invalidSupportBars).toBe(1)

    const valid = planPurchase(group([[1000, 8]], false, 30), {
      stockLengthsMm: [10500],
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    expect(valid.invalidSupportBars).toBe(0)

    const preferred = planPurchase(group([[1000, 8]], false, 30), {
      stockLengthsMm: [9000, 10500],
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    // The 10.5 m bar is longer but keeps the last piece out of the support zone.
    expect(preferred.purchases).toEqual([{ lengthMm: 10500, count: 1 }])
    expect(preferred.invalidSupportBars).toBe(0)
  })

  it('accounts for pieces in every quantity', () => {
    const plan = planPurchase(group([[2000, 5]]), {
      stockLengthsMm: STOCK,
      marginMm: DEFAULT_CHUCK_MARGIN_MM,
    })
    expect(plan.pieceCount).toBe(5)
    expect(plan.requiredMm).toBe(10000)
    expect(plan.purchasedMm).toBe(10500)
  })
})
