import { describe, it, expect } from 'vitest';
import { SGEEngine } from './engine';
import { buildSGEConfig } from './config';

function makeConfig() {
  return buildSGEConfig({
    preset: 'balanced',
    centralGravity: 0, // disable centering for these tests
    linkCountAttraction: false,
    clustering: false,
  });
}

function stepTimes(engine: SGEEngine, n: number): void {
  for (let i = 0; i < n; i++) engine.step();
}

describe('SGEEngine', () => {
  it('initialises deterministically with the same seed', () => {
    const cfg = makeConfig();
    const nodes = [{ nodeUuid: 'a' }, { nodeUuid: 'b' }, { nodeUuid: 'c' }];
    const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    const a = new SGEEngine(nodes, edges, cfg).getState();
    const b = new SGEEngine(nodes, edges, cfg).getState();
    expect(Array.from(a.posX)).toEqual(Array.from(b.posX));
    expect(Array.from(a.posY)).toEqual(Array.from(b.posY));
  });

  it('respects pinning: pinned nodes are not moved by forces', () => {
    const cfg = makeConfig();
    cfg.springStrength = 0.5;
    cfg.idealDistance = 100;
    cfg.componentCenterStrength = 0;
    const engine = new SGEEngine(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b', type: 'reference' }],
      cfg,
    );
    engine.pinNode('a');
    engine.moveNode('a', 0, 0);
    engine.moveNode('b', 200, 0);
    stepTimes(engine, 5);
    const s = engine.getState();
    expect(s.posX[0]).toBe(0);
    expect(s.posY[0]).toBe(0);
    // The unpinned node should have moved toward the pinned node
    expect(s.posX[1]).toBeLessThan(200);
  });

  it('preserves positions of surviving nodes across topology changes', () => {
    const cfg = makeConfig();
    const engine = new SGEEngine(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }, { nodeUuid: 'c' }],
      [{ source: 'a', target: 'b' }],
      cfg,
    );
    engine.moveNode('a', 123, 456);
    engine.moveNode('b', -100, -200);
    engine.setTopology(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b' }],
    );
    const s = engine.getState();
    expect(s.posX[0]).toBeCloseTo(123);
    expect(s.posY[0]).toBeCloseTo(456);
    expect(s.posX[1]).toBeCloseTo(-100);
    expect(s.posY[1]).toBeCloseTo(-200);
  });

  it('uses explicit incoming positions over preserved ones', () => {
    const cfg = makeConfig();
    const engine = new SGEEngine(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b' }],
      cfg,
    );
    engine.moveNode('a', 999, 999);
    engine.setTopology(
      [{ nodeUuid: 'a', x: 50, y: 60 }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b' }],
    );
    const s = engine.getState();
    expect(s.posX[0]).toBe(50);
    expect(s.posY[0]).toBe(60);
  });

  it('initialises pinned state from node descriptors', () => {
    const cfg = makeConfig();
    const engine = new SGEEngine(
      [{ nodeUuid: 'a', pinned: true }, { nodeUuid: 'b' }],
      [{ source: 'a', target: 'b', type: 'reference' }],
      cfg,
    );
    engine.moveNode('a', 0, 0);
    engine.moveNode('b', 200, 0);
    stepTimes(engine, 5);
    const s = engine.getState();
    expect(s.posX[0]).toBe(0);
    expect(s.posY[0]).toBe(0);
  });
});
