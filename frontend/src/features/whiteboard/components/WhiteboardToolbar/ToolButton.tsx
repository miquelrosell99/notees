import React from 'react';
import { Button } from '@/components/ui/Button';

export interface ToolButtonProps {
  icon: string;
  label: string;
  shortcut: string;
  active: boolean;
  onClick: () => void;
}

export const ToolButton: React.FC<ToolButtonProps> = ({ icon, label, shortcut, active, onClick }) => (
  <Button
    aria-label={label}
    icon={icon}
    variant="ghost"
    size="sm"
    active={active}
    onClick={onClick}
    title={`${label}${shortcut ? ` (${shortcut})` : ''}`}
  />
);
