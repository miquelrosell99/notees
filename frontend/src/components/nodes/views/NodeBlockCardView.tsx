/**
 * NodeBlockCardView — Card view wrapper.
 *
 * Thin passthrough to CardModeView, which handles the full card grid
 * with per-card Lexical editors, metadata rows, cover images, etc.
 */
import type { JSX } from 'react';
import { CardModeView } from '../../../editor/CardModeView';
import type { NodeCardViewProps } from '@/types/nodeCollection';
import './NodeBlockCardView.css';

export function NodeBlockCardView(props: NodeCardViewProps): JSX.Element {
  return (
    <div className={`node-block-card-view ${props.className || ''}`}>
      <CardModeView {...props} />
    </div>
  );
}
