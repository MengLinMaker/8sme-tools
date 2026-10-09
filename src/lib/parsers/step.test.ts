import { describe, expect, it } from 'vitest'
import { parseStepFile } from './step'

const VALID_STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Open CASCADE Model'),'2;1');
FILE_NAME('Open CASCADE Shape Model','2025-12-12T15:47:10',('Author'),('Open CASCADE'),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('',(0.,0.,0.));
#2 = DIRECTION('',(0.,0.,1.));
ENDSEC;
END-ISO-10303-21;`

describe('parseStepFile', () => {
  it('accepts a well-formed AP214 STEP file', () => {
    const step = parseStepFile('a1.stp', VALID_STEP)
    expect(step.valid).toBe(true)
    expect(step.problems).toEqual([])
    expect(step.schema).toBe('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }')
    expect(step.entityCount).toBe(2)
  })

  it('detects a truncated STEP file', () => {
    const step = parseStepFile('a1.stp', VALID_STEP.replace('\nEND-ISO-10303-21;', ''))
    expect(step.valid).toBe(false)
    expect(step.problems.join(' ')).toContain('END-ISO-10303-21')
  })

  it('detects a non-STEP file', () => {
    const step = parseStepFile('a1.stp', 'this is not a step file')
    expect(step.valid).toBe(false)
    expect(step.problems.length).toBeGreaterThan(0)
  })
})
