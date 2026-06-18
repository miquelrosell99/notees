/**
 * SGE v2 — Velocity Verlet integrator with adaptive timestep.
 */

import type { SGEConfig } from './types';

export interface IntegratorState {
  prevDt: number;
  prevEnergy: number;
  oscillationCounter: number;
}

export function createIntegratorState(cfg: SGEConfig): IntegratorState {
  return {
    prevDt: cfg.dt,
    prevEnergy: Infinity,
    oscillationCounter: 0,
  };
}

/** Integrate one step. Returns average kinetic energy. */
export function integrate(
  state: IntegratorState,
  cfg: SGEConfig,
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
): number {
  const dt = state.prevDt;
  const hdt2 = 0.5 * dt * dt;
  const maxVel = cfg.maxVelocity;
  const maxV2 = maxVel * maxVel;
  const friction = cfg.friction;
  let totalEnergy = 0;

  for (let k = 0; k < activeCount; k++) {
    const i = activeIdx[k];
    const oax = oldAx[i], oay = oldAy[i];
    const nax = ax[i], nay = ay[i];
    let vx = velX[i] + 0.5 * (oax + nax) * dt;
    let vy = velY[i] + 0.5 * (oay + nay) * dt;
    const v2 = vx * vx + vy * vy;
    if (v2 > maxV2) {
      const s = maxVel / Math.sqrt(v2);
      vx *= s; vy *= s;
    }
    vx *= friction; vy *= friction;
    // Sleep threshold: model static friction. When speed drops below this,
    // clamp to zero so the node truly rests instead of drifting forever.
    // Any force will re-awaken it automatically on the next tick.
    const SLEEP_V = 1e-4;
    if (Math.abs(vx) < SLEEP_V && Math.abs(vy) < SLEEP_V) { vx = 0; vy = 0; }
    posX[i] += velX[i] * dt + oax * hdt2;
    posY[i] += velY[i] * dt + oay * hdt2;
    velX[i] = vx; velY[i] = vy;
    totalEnergy += (vx * vx + vy * vy);
  }

  const energy = n > 0 ? totalEnergy / n : 0;

  // Adaptive timestep
  if (energy > state.prevEnergy * 1.1 && energy > 0.01) {
    if (++state.oscillationCounter > 3) {
      state.prevDt = Math.max(cfg.dt * 0.25, state.prevDt * 0.6);
      state.oscillationCounter = 0;
    }
  } else {
    state.oscillationCounter = 0;
    if (state.prevDt < cfg.dt) state.prevDt = Math.min(cfg.dt, state.prevDt * 1.02);
  }
  state.prevEnergy = energy;

  return energy;
}
