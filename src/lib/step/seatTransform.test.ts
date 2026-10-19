import { Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { rigidFromMatrix } from './seat'

function matrixOf(
  axis: [number, number, number],
  angleDeg: number,
  position: [number, number, number],
): Matrix4 {
  const [x, y, z] = axis
  const quaternion = new Quaternion().setFromAxisAngle(
    new Vector3(x, y, z).normalize(),
    (angleDeg * Math.PI) / 180,
  )
  return new Matrix4().compose(new Vector3(...position), quaternion, new Vector3(1, 1, 1))
}

describe('rigidFromMatrix', () => {
  it('splits a quarter-turn about Z plus a translation', () => {
    const matrix = matrixOf([0, 0, 1], 90, [3, -4, 5])
    const rigid = rigidFromMatrix(matrix)
    expect(Math.abs(rigid.angleDeg)).toBeCloseTo(90, 6)
    expect(rigid.axis.map(Math.abs)).toEqual([0, 0, 1])
    expect(rigid.position).toEqual([3, -4, 5])
  })

  it('round-trips an arbitrary rotation+translation', () => {
    const matrix = matrixOf([1, 2, 3], 37, [-8, 2, 11])
    const rigid = rigidFromMatrix(matrix)
    const rebuilt = matrixOf(rigid.axis, rigid.angleDeg, rigid.position)
    for (const [a, b] of matrix.toArray().map((v, i) => [v, rebuilt.toArray()[i]])) {
      expect(a).toBeCloseTo(b, 6)
    }
  })

  it('treats an identity matrix as a zero-angle rotation about Z', () => {
    const rigid = rigidFromMatrix(new Matrix4())
    expect(rigid.angleDeg).toBeCloseTo(0, 9)
    expect(rigid.position).toEqual([0, 0, 0])
  })
})
