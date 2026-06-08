/**
 * SGE v2 — Config translation.
 *
 * Maps the user-facing SGEPhysicsConfig to raw numeric SGEConfig.
 */

import type { SGEPhysicsConfig, SGEConfig } from './types';

const PHYSICS_PRESETS: Record<SGEPhysicsConfig['preset'], Partial<SGEConfig>> = {
  sparse: {
    springStrength: 0.018,
    idealDistance: 130,
    componentCenterStrength: 0.0010,
    clusterRepelStrength: 2700,
    localRepelStrength: 3600,
    clusterSpacing: 450,
    componentSpacing: 1000,
  },
  balanced: {
    springStrength: 0.025,
    idealDistance: 100,
    componentCenterStrength: 0.0012,
    clusterRepelStrength: 2000,
    localRepelStrength: 3000,
    clusterSpacing: 350,
    componentSpacing: 800,
  },
  compact: {
    springStrength: 0.040,
    idealDistance: 70,
    componentCenterStrength: 0.0024,
    clusterRepelStrength: 1100,
    localRepelStrength: 1400,
    clusterSpacing: 200,
    componentSpacing: 500,
  },
  clustered: {
    springStrength: 0.022,
    idealDistance: 110,
    componentCenterStrength: 0.0010,
    clusterRepelStrength: 3400,
    localRepelStrength: 4200,
    clusterSpacing: 400,
    componentSpacing: 900,
  },
};

/** Translate user-facing config to raw physics constants. */
export function buildSGEConfig(user: SGEPhysicsConfig): SGEConfig {
  const preset = PHYSICS_PRESETS[user.preset];
  const clusterMult = user.clustering ? 1.8 : 1.0;

  return {
    seed: 42,
    springStrength: user.linkCountAttraction
      ? (preset.springStrength ?? 0.025) * 1.8
      : (preset.springStrength ?? 0.025),
    idealDistance: preset.idealDistance ?? 100,
    clusterStrength: 0.003 * clusterMult,
    clusterRepelStrength: (preset.clusterRepelStrength ?? 2000) * clusterMult,
    clusterSpacing: preset.clusterSpacing ?? 350,
    localRepelStrength: (preset.localRepelStrength ?? 3000) * (user.clustering ? 1.4 : 1.0),
    localRepelRadius: 500,
    radialStrength: 0.0005,
    componentCenterStrength: user.centralGravity
      ? (preset.componentCenterStrength ?? 0.0012)
      : 0,
    componentSpacing: preset.componentSpacing ?? 800,
    damping: 0.85,
    maxVelocity: 10,
    friction: 0.92,
    dt: 0.5,
    bhTheta: 1.0,
    alphaDecay: 0.02,
    alphaMin: 0.001,
    linkCountAttraction: user.linkCountAttraction,
  };
}
