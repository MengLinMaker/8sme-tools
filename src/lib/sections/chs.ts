/**
 * Circular Hollow Section (CHS) outside diameters commonly stocked in Australia
 * (AS/NZS 1163 / AS 1074). CHS has no fixed size table like the rolled I/channel families —
 * the wall comes from the callout — but the **outside diameter** is a discrete mill size, so a
 * measured outline can be snapped back to its nominal OD instead of carrying sampling noise into
 * the callout (e.g. a real 508.0 OD reading 507.5 from a faceted slice).
 */
export const CHS_OUTSIDE_DIAMETERS = [
  21.3, 26.9, 33.7, 42.4, 48.3, 60.3, 76.1, 88.9, 101.6, 114.3, 139.7, 165.1, 168.3, 193.7, 219.1,
  244.5, 273.1, 323.9, 355.6, 406.4, 457.2, 508.0, 610.0,
] as const

/**
 * Nearest standard CHS outside diameter to a measured one, within a relative tolerance
 * (default 1%). Returns the measured value unchanged when it is not near a standard size, so an
 * unusual/custom tube still reads at its real size.
 */
export function snapChsOutsideDiameter(measured: number, tolerance = 0.01): number {
  let best = measured
  let bestDelta = Number.POSITIVE_INFINITY
  for (const nominal of CHS_OUTSIDE_DIAMETERS) {
    const delta = Math.abs(nominal - measured)
    if (delta <= Math.max(0.5, measured * tolerance) && delta < bestDelta) {
      bestDelta = delta
      best = nominal
    }
  }
  return best
}
