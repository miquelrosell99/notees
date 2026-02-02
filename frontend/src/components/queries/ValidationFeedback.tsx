/**
 * ValidationFeedback Component
 * 
 * Displays validation errors, warnings, and info messages inline.
 * Only shows actionable feedback without being intrusive.
 */

import type { ValidationResult } from '@/types/queryAST';
import './ValidationFeedback.css';

// ==================== Types ====================

interface ValidationFeedbackProps {
  validationResult: ValidationResult;
}

// ==================== Component ====================

export function ValidationFeedback({ validationResult }: ValidationFeedbackProps) {
  const { issues } = validationResult;
  
  // Filter out info-level issues for less noise
  const actionableIssues = issues.filter(issue => issue.severity !== 'info');
  
  if (actionableIssues.length === 0) {
    return null;
  }
  
  // Group by severity
  const errors = actionableIssues.filter(i => i.severity === 'error');
  const warnings = actionableIssues.filter(i => i.severity === 'warning');
  
  return (
    <div className="validation-feedback">
      {errors.length > 0 && (
        <div className="validation-feedback__section validation-feedback__section--error">
          <div className="validation-feedback__header">
            <span className="validation-feedback__icon">⚠️</span>
            <span className="validation-feedback__title">
              {errors.length} error{errors.length !== 1 ? 's' : ''}
            </span>
          </div>
          <ul className="validation-feedback__list">
            {errors.map((issue, index) => (
              <li key={index} className="validation-feedback__item">
                <span className="validation-feedback__message">{issue.message}</span>
                {issue.suggestion && (
                  <span className="validation-feedback__suggestion">
                    {issue.suggestion}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      
      {warnings.length > 0 && (
        <div className="validation-feedback__section validation-feedback__section--warning">
          <div className="validation-feedback__header">
            <span className="validation-feedback__icon">⚡</span>
            <span className="validation-feedback__title">
              {warnings.length} warning{warnings.length !== 1 ? 's' : ''}
            </span>
          </div>
          <ul className="validation-feedback__list">
            {warnings.map((issue, index) => (
              <li key={index} className="validation-feedback__item">
                <span className="validation-feedback__message">{issue.message}</span>
                {issue.suggestion && (
                  <span className="validation-feedback__suggestion">
                    {issue.suggestion}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default ValidationFeedback;
