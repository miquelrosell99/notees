/**
 * Velocity Verlet integrator with adaptive timestep..
 */

import type { GraphEngineConfig } from './types.js';

export interface IntegratorState {
  prevDt: number;
  prevEnergy: number;
  oscillationCounter: number;
}

export function createIntegratorState(cfg: GraphEngineConfig): IntegratorState {
  return {
    prevDt: cfg.dt,
    prevEnergy: Infinity,
    oscillationCounter: 0,
  };
}

/** Integrate one step. Returns average kinetic energy. */
export function integrate(
  state: IntegratorState,
  cfg: GraphEngineConfig,
  n: number,
  activeCount: number,
  activeIdx: Int32Array,
  posX: Float32Array,
  posY: Float32Array,
  velX: Float32Array,
  velY: Float32Array,
  ax: Float32Array,
  ay: Float32Array,
  oldAx: Float32Array,
  oldAy: Float32Array,
  mass: Float32Array,
): number {
  const dt = state.prevDt;
  const hdt2 = 0.5 * dt * dt;
  const maxVel = cfg.maxVelocity;
  const maxV2 = maxVel * maxVel;
  const drag = cfg.drag;
  const useMass = cfg.useMass === true;
  let totalEnergy = 0;

  for (let k = 0; k < activeCount; k++) {
    const i = activeIdx[k]!;
    // Mass accumulation: heavy parents (descendant weight) accelerate slower.
    const invMass = useMass ? 1 / Math.max(mass[i]!, 1) : 1;
    const oax = oldAx[i]! * invMass, oay = oldAy[i]! * invMass;
    const nax = ax[i]! * invMass, nay = ay[i]! * invMass;
    let vx = velX[i]! + 0.5 * (oax + nax) * dt;
    let vy = velY[i]! + 0.5 * (oay + nay) * dt;
    const v2 = vx * vx + vy * vy;
    if (v2 > maxV2) {
      const s = maxVel / Math.sqrt(v2);
      vx *= s; vy *= s;
    }
    // Constant dissipative drag. At equilibrium the forces scale to zero with
    // alpha, so velocity bleeds out and the graph rests at a true force
    // balance — convergence is measured (the settle gate), not imposed.
    vx *= drag; vy *= drag;
    // Denormal-drift guard only: far below any visible motion. Stillness
    // itself comes from the force balance, not from this clamp.
    const SLEEP_V = 1e-6;
    if (Math.abs(vx) < SLEEP_V && Math.abs(vy) < SLEEP_V) { vx = 0; vy = 0; }
    posX[i]! += velX[i]! * dt + oax * hdt2;
    posY[i]! += velY[i]! * dt + oay * hdt2;
    velX[i] = vx; velY[i] = vy;
    // The settle gate reads this as per-tick displacement² — dt-aware, so a
    // shrunken adaptive timestep can't make a moving graph look still.
    totalEnergy += (vx * vx + vy * vy) * dt * dt;
  }

  const energy = n > 0 ? totalEnergy / n : 0;

  // Adaptive timestep: shrink on sustained oscillation, recover promptly
  // once energy is falling again.
  if (energy > state.prevEnergy * 1.1 && energy > 0.01) {
    if (++state.oscillationCounter > 3) {
      state.prevDt = Math.max(cfg.dt * 0.25, state.prevDt * 0.6);
      state.oscillationCounter = 0;
    }
  } else {
    state.oscillationCounter = 0;
    if (state.prevDt < cfg.dt) state.prevDt = Math.min(cfg.dt, state.prevDt * 1.5);
  }
  state.prevEnergy = energy;

  return energy;
}
