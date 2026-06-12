/**
 * Router hooks — Barrel File
 *
 * Re-exports the lightweight URL parsing/building utilities. Direct history
 * mutation has been removed in favour of react-router-dom.
 */
export {
  SPECIAL_VIEWS,
  isUuid,
  VIEW_TO_PATH,
  parseUrl,
  buildUrl,
  type ParsedRoute,
} from './useRouter.utils';
