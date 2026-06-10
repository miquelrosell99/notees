/**
 * Whiteboard Shape Registry
 *
 * Declarative registry for whiteboard shape path generators.
 * Each shape type self-registers its path generator function,
 * eliminating the central switch statement in whiteboardShapeUtils.ts.
 */

export interface ShapePathGenerator {
  type: string;
  getPath(width: number, height: number): string;
}

const registry = new Map<string, ShapePathGenerator>();

export function registerShapePathGenerator(generator: ShapePathGenerator): void {
  if (registry.has(generator.type)) {
    console.warn(`ShapePathGenerator for type "${generator.type}" is being overwritten.`);
  }
  registry.set(generator.type, generator);
}

export function getShapePathGenerator(type: string): ShapePathGenerator | undefined {
  return registry.get(type);
}

export function getRegisteredShapeTypes(): string[] {
  return Array.from(registry.keys());
}
