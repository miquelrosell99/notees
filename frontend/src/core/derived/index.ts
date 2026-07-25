import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { applyNodeOperation } from './node';
import { applyChildOrderOperation } from './childOrder';
import { applyPropertyOperation } from './property';
import { applyNodeViewOperation } from './nodeView';
import { applyAssetOperation } from './asset';
import { applyTaskOperation } from './task';
import { applyActivityOperation } from './activity';
import { applyLinkOperation } from './link';
import { applyShareOperation } from './share';
import { applyPluginOperation } from './plugin';
import { applyFavoriteOperation } from './favorite';
import { applyClassOperation } from './class';

export function applyOperation(db: Database, op: Operation): void {
  // For node.delete the node row is removed, so class metadata must be
  // updated before the node applier runs.
  if (op.envelope.opType === 'node.delete') {
    applyClassOperation(db, op);
  }

  applyNodeOperation(db, op);

  if (op.envelope.opType !== 'node.delete') {
    applyClassOperation(db, op);
  }

  applyChildOrderOperation(db, op);
  applyPropertyOperation(db, op);
  applyNodeViewOperation(db, op);
  applyAssetOperation(db, op);
  applyTaskOperation(db, op);
  applyActivityOperation(db, op);
  applyLinkOperation(db, op);
  applyShareOperation(db, op);
  applyPluginOperation(db, op);
  applyFavoriteOperation(db, op);
}

export * from './class';
