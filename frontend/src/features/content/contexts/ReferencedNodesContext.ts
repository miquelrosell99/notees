import { createContext } from 'react';
import type { Node } from '@/types/api';

export type ReferencedNodesMap = Record<string, Node>;

export const ReferencedNodesContext = createContext<ReferencedNodesMap>({});
