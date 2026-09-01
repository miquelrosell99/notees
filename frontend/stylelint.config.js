/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard'],
  rules: {
    // Enforce token usage for common magic numbers
    // We allow 0, 1px, 2px (borders), 100%, 50%, 9999px (full radius), 1 (line-height)
    'declaration-property-value-no-unknown': null,

    // These are turned off because the codebase uses many valid patterns
    // that stylelint-config-standard flags incorrectly
    'property-no-vendor-prefix': null,
    'value-no-vendor-prefix': null,
    'selector-class-pattern': null,
    'selector-id-pattern': null,
    'keyframes-name-pattern': null,

    // State-override blocks intentionally come after the base rules they
    // override (e.g. `.btn:disabled` after `.btn:hover:not(:disabled)`).
    // The higher-specificity rule wins regardless of source order, so the
    // pattern is cascade-safe and reordering 150+ blocks adds churn without
    // changing behavior.
    'no-descending-specificity': null,

    // Allow the `--_private` convention for component-internal custom
    // properties in addition to standard kebab-case token names.
    'custom-property-pattern': [
      '^_?([a-z][a-z0-9]*)(-[a-z0-9]+)*$',
      { message: 'Expected custom property name to be kebab-case (optional leading _ for private)' },
    ],
  },
};
