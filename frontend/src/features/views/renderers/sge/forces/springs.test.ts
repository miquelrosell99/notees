import { describe, it, expect } from 'vitest';
import { SGEEngine } from '../engine';
import { buildSGEConfig } from '../config';

function makeConfig() {
  return buildSGEConfig({
    preset: 'balanced',
    centralGravity: 0,
    linkCountAttraction: false,
    clustering: false,
  });
}

function stepTimes(engine: SGEEngine, n: number): void {
  for (let i = 0; i < n; i++) engine.step();
}

describe('SpringForce', () => {
  it('pulls stretched linked nodes together', () => {
    const cfg = makeConfig();
    cfg.springStrength = 0.5;
    cfg.idealDistance = 100;
    cfg.componentCenterStrength = 0;
    const engine = new SGEEngine(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b', type: 'reference' }],
      cfg,
    );
    engine.moveNode('a', 0, 0);
    engine.moveNode('b', 200, 0);
    stepTimes(engine, 5);
    const s = engine.getState();
    expect(s.posX[0]).toBeGreaterThan(0);
    expect(s.posX[1]).toBeLessThan(200);
  });

  it('pushes compressed linked nodes apart', () => {
    const cfg = makeConfig();
    cfg.springStrength = 0.5;
    cfg.idealDistance = 100;
    cfg.componentCenterStrength = 0;
    const engine = new SGEEngine(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b', type: 'reference' }],
      cfg,
    );
    engine.moveNode('a', 0, 0);
    engine.moveNode('b', 10, 0);
    stepTimes(engine, 5);
    const s = engine.getState();
    expect(s.posX[0]).toBeLessThan(0);
    expect(s.posX[1]).toBeGreaterThan(10);
  });

  it('resists compression more strongly for parent links', () => {
    const cfg = makeConfig();
    cfg.springStrength = 0.5;
    cfg.idealDistance = 100;
    cfg.componentCenterStrength = 0;

    const referenceEngine = new SGEEngine(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b', type: 'reference' }],
      cfg,
    );
    referenceEngine.moveNode('a', 0, 0);
    referenceEngine.moveNode('b', 10, 0);
    stepTimes(referenceEngine, 5);
    const refSep = referenceEngine.getState().posX[1] - referenceEngine.getState().posX[0];

    const parentEngine = new SGEEngine(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b', type: 'parent' }],
      cfg,
    );
    parentEngine.moveNode('a', 0, 0);
    parentEngine.moveNode('b', 10, 0);
    stepTimes(parentEngine, 5);
    const parentSep = parentEngine.getState().posX[1] - parentEngine.getState().posX[0];

    expect(parentSep).toBeGreaterThan(refSep);
  });
});
