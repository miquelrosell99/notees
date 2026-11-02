/**
 * resolveCoordinates — the resolver's server coordinates (serverUrl +
 * credential), registered once by the app-level AddSourceHost and consumed
 * by any surface that needs an ad-hoc metadata resolve without threading
 * props through the whole tree (the AddSourceHost/requestAddSource idiom:
 * the coordinates live at the app root; the metadata panel's asset row is
 * many levels away).
 *
 * The consumer pattern (the OA-PDF Fetch button on a source's attachments
 * row) reads the coordinates at CLICK time — offline mode (null) simply
 * hides the affordance.
 */

export interface ResolveCoordinates {
  serverUrl: string;
  credential: string;
}

let coordinates: ResolveCoordinates | null = null;

/** The AddSourceHost effect registers (and clears) the coordinates. */
export function registerResolveCoordinates(next: ResolveCoordinates | null): void {
  coordinates = next;
}

/** The current coordinates, null in offline mode or before any host mounts. */
export function resolveCoordinates(): ResolveCoordinates | null {
  return coordinates;
}
