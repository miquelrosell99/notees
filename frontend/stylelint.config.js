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
  },
};
