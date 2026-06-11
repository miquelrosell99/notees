/**
 * Router hooks — Barrel File
 */
export {
  SPECIAL_VIEWS,
  isUuid,
  VIEW_TO_PATH,
  parseUrl,
  buildUrl,
  pushUrl,
  replaceUrl,
  type ParsedRoute,
} from './useRouter.utils';
export { useRouter, useCurrentNodeUuid } from './useRouter.hook';
