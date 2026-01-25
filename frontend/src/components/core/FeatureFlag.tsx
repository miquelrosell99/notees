/**
 * Feature Flag React Components
 * 
 * JSX components for conditional rendering based on feature flags.
 * Separated from store to allow proper .tsx extension handling.
 */
import type { ReactNode, ComponentType } from 'react';
import { useFeatureFlag, type FeatureFlagName } from '../../stores/featureFlagStore';

/**
 * HOC to conditionally render a component based on feature flag
 * 
 * Usage:
 * ```tsx
 * const NewFeature = withFeatureFlag(NewComponent, 'featureName', LegacyComponent);
 * ```
 */
export function withFeatureFlag<P extends object>(
  Component: ComponentType<P>,
  flagName: FeatureFlagName,
  FallbackComponent?: ComponentType<P>
) {
  return function FeatureFlaggedComponent(props: P) {
    const isEnabled = useFeatureFlag(flagName);
    
    if (isEnabled) {
      return <Component {...props} />;
    }
    
    if (FallbackComponent) {
      return <FallbackComponent {...props} />;
    }
    
    return null;
  };
}

/**
 * Component for conditionally rendering based on feature flag
 * 
 * Usage:
 * ```tsx
 * <FeatureFlag name="newEditor" fallback={<LegacyEditor />}>
 *   <NewEditor />
 * </FeatureFlag>
 * ```
 */
export function FeatureFlag({
  name,
  children,
  fallback = null,
}: {
  name: FeatureFlagName;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const isEnabled = useFeatureFlag(name);
  return <>{isEnabled ? children : fallback}</>;
}
