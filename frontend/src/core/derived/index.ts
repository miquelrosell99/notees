import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import type { NotifyScope } from '../worker/workerProtocol';
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

export interface ChangeNotification {
  scope: NotifyScope;
  nodeId?: string;
  relatedIds?: string[];
}

export function applyOperation(db: Database, op: Operation): ChangeNotification[] {
  const notifications: ChangeNotification[] = [];

  // For node.delete the node row is removed, so class metadata must be
  // updated before the node applier runs.
  if (op.envelope.opType === 'node.delete') {
    notifications.push(...applyClassOperation(db, op));
  }

  notifications.push(...applyNodeOperation(db, op));

  if (op.envelope.opType !== 'node.delete') {
    notifications.push(...applyClassOperation(db, op));
  }

  notifications.push(...applyChildOrderOperation(db, op));
  notifications.push(...applyPropertyOperation(db, op));
  notifications.push(...applyNodeViewOperation(db, op));
  notifications.push(...applyAssetOperation(db, op));
  notifications.push(...applyTaskOperation(db, op));
  notifications.push(...applyActivityOperation(db, op));
  notifications.push(...applyLinkOperation(db, op));
  notifications.push(...applyShareOperation(db, op));
  notifications.push(...applyPluginOperation(db, op));
  notifications.push(...applyFavoriteOperation(db, op));

  return notifications;
}

export * from './class';
