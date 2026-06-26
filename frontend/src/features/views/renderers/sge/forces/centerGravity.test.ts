import { describe, it, expect } from 'vitest';
import { SGEEngine } from '../engine';
import { buildSGEConfig } from '../config';

function makeConfig(centerStrength: number) {
  const cfg = buildSGEConfig({
    preset: 'balanced',
    centralGravity: 0,
    linkCountAttraction: false,
    clustering: false,
  });
  cfg.componentCenterStrength = centerStrength;
  cfg.springStrength = 0;
  cfg.localRepelStrength = 0;
  cfg.clusterStrength = 0;
  cfg.clusterRepelStrength = 0;
  return cfg;
}

function stepTimes(engine: SGEEngine, n: number): void {
  for (let i = 0; i < n; i++) engine.step();
}

describe('CenterGravityForce', () => {
  it('pulls nodes toward the origin', () => {
    const cfg = makeConfig(0.1);
    const engine = new SGEEngine(
      [{ nodeUuid: 'a' }, { nodeUuid: 'b' }],
      [],
      cfg,
    );
    engine.moveNode('a', 100, 50);
    engine.moveNode('b', -80, -40);
    stepTimes(engine, 10);
    const s = engine.getState();
    // Both nodes should have moved toward zero.
    expect(Math.abs(s.posX[0])).toBeLessThan(100);
    expect(Math.abs(s.posY[0])).toBeLessThan(50);
    expect(Math.abs(s.posX[1])).toBeLessThan(80);
    expect(Math.abs(s.posY[1])).toBeLessThan(40);
  });

  it('does nothing when center strength is zero', () => {
    const cfg = makeConfig(0);
    const engine = new SGEEngine(
      [{ nodeUuid: 'a' }],
      [],
      cfg,
    );
    engine.moveNode('a', 100, 100);
    stepTimes(engine, 5);
    const s = engine.getState();
    expect(s.posX[0]).toBe(100);
    expect(s.posY[0]).toBe(100);
  });
});
