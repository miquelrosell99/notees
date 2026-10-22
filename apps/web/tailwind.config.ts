/**
 * Tailwind config — wires Tailwind utilities to the app's design tokens
 * (CSS custom properties, see src/ui/variables.css). Adapted from the
 * RosellRamos starter asset (rosellramos-design-system → assets/tailwind.config.ts,
 * v2026.10.19) to the Notees token names.
 *
 * Tailwind is an implementation layer, NOT a design system: its default
 * palette, radii, spacing, and durations are never used — every utility a
 * component may cite maps to a token here (the registered-mapping mode of
 * the drift gate, test/css-token-drift.test.ts). The shadcn catalog theme
 * keys (background, foreground, …) resolve through the alias layer in
 * variables.css, which follows [data-theme] / [data-accent] / [data-oled]
 * for free — re-theming propagates into every catalog component with zero
 * component edits.
 *
 * ⚠ --accent is NOT the fleet accent — per the shadcn bridge it maps to the
 * hover register (--md-sys-color-hover-overlay); the seed is --primary.
 */
import type { Config } from "tailwindcss";

/** Every Material You color role the catalog and wrappers cite. */
function role(name: string) {
  return `var(--md-sys-color-${name})`;
}

export default {
  // The app's co-located CSS layer predates Tailwind and carries its own
  // element resets (app.css) — preflight stays OFF so adoption changes no
  // existing surface. Catalog components are written preflight-independent:
  // they always set their own border colors, backgrounds, and margins.
  corePlugins: { preflight: false },
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        /* —— shadcn alias layer (bridge: components/shadcn-bridge.md) —— */
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: "var(--card)",
        "card-foreground": "var(--card-foreground)",
        popover: "var(--popover)",
        "popover-foreground": "var(--popover-foreground)",
        primary: "var(--primary)",
        "primary-foreground": "var(--primary-foreground)",
        secondary: "var(--secondary)",
        "secondary-foreground": "var(--secondary-foreground)",
        muted: "var(--muted)",
        "muted-foreground": "var(--muted-foreground)",
        accent: "var(--accent)",
        "accent-foreground": "var(--accent-foreground)",
        destructive: "var(--destructive)",
        "destructive-foreground": "var(--destructive-foreground)",
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        /* —— Material You roles (cite the role, never a hue) —— */
        "on-background": role("on-background"),
        surface: role("surface"),
        "on-surface": role("on-surface"),
        "surface-variant": role("surface-variant"),
        "on-surface-variant": role("on-surface-variant"),
        "surface-dim": role("surface-dim"),
        "surface-bright": role("surface-bright"),
        "surface-container": role("surface-container"),
        "surface-container-low": role("surface-container-low"),
        "surface-container-lowest": role("surface-container-lowest"),
        "surface-container-high": role("surface-container-high"),
        "surface-container-highest": role("surface-container-highest"),
        "surface-container-active": role("surface-container-active"),
        "inverse-surface": role("inverse-surface"),
        "inverse-on-surface": role("inverse-on-surface"),
        "inverse-primary": role("inverse-primary"),
        "on-primary": role("on-primary"),
        "primary-container": role("primary-container"),
        "on-primary-container": role("on-primary-container"),
        "primary-hover": role("primary-hover"),
        "primary-pressed": role("primary-pressed"),
        "secondary-container": role("secondary-container"),
        "on-secondary-container": role("on-secondary-container"),
        tertiary: role("tertiary"),
        "on-tertiary": role("on-tertiary"),
        "tertiary-container": role("tertiary-container"),
        "on-tertiary-container": role("on-tertiary-container"),
        error: role("error"),
        "on-error": role("on-error"),
        "error-container": role("error-container"),
        "on-error-container": role("on-error-container"),
        "error-hover": role("error-hover"),
        "error-pressed": role("error-pressed"),
        "on-warning": role("on-warning"),
        outline: role("outline"),
        "outline-variant": role("outline-variant"),
        scrim: role("scrim"),
        "hover-overlay": role("hover-overlay"),
        "pressed-overlay": role("pressed-overlay"),
        "focus-overlay": role("focus-overlay"),
        success: role("success"),
        warning: role("warning"),
        info: role("info"),
      },
      fontFamily: {
        sans: ["var(--font-family-base)"],
        content: ["var(--font-family-content)"],
        mono: ["var(--font-family-mono)"],
      },
      fontSize: {
        "3xs": "var(--font-size-3xs)",
        "2xs": "var(--font-size-2xs)",
        xs: "var(--font-size-xs)",
        sm: "var(--font-size-sm)",
        button: "var(--font-size-button)",
        base: "var(--font-size-base)",
        "body-lg": "var(--font-size-body-lg)",
        "body-xl": "var(--font-size-body-xl)",
        "title-lg": "var(--font-size-title-lg)",
        md: "var(--font-size-md)",
        lead: "var(--font-size-lead)",
        lg: "var(--font-size-lg)",
        hero: "var(--font-size-hero)",
        "3xl": "var(--font-size-3xl)",
        "4xl": "var(--font-size-4xl)",
      },
      borderRadius: {
        /* The fleet shape scale (rulings: buttons the rounded square at
           every size — owner ruling 2026-10-20, the switcher's
           shape-medium; popovers 4px, cards 20px, sheets 28px). */
        card: "var(--radius-card)",
        sheet: "var(--radius-sheet)",
        dialog: "var(--radius-dialog)",
        button: "var(--radius-button-lg)",
        "button-sm": "var(--radius-button-sm)",
        input: "var(--radius-input)",
        item: "var(--radius-item)",
        popover: "var(--radius-popover)",
        badge: "var(--radius-badge)",
        full: "var(--radius-full)",
        menu: "var(--radius-menu)",
        floating: "var(--shape-floating-panel)",
        /* The sub-item corners (skeleton rows, check chips). */
        "shape-xs": "var(--shape-extra-small)",
        "shape-sm": "var(--shape-small)",
        /* The shared rounded-square (owner ruling 2026-10-20): buttons and
           checkboxes wear the switcher's shape-medium. */
        "shape-md": "var(--shape-medium)",
      },
      boxShadow: {
        /* M3 elevation: level 1 static cards/rails, 2 menus/popovers,
           3 dialogs (owner ruling 2026-10-16). */
        card: "var(--elevation-1)",
        popover: "var(--elevation-2)",
        modal: "var(--elevation-3)",
        overlay: "var(--elevation-3)",
        none: "var(--elevation-0)",
        level1: "var(--elevation-1)",
        level2: "var(--elevation-2)",
        level3: "var(--elevation-3)",
        /* The switch track's inset rings (BooleanToggle). */
        "inset-outline-ring": "var(--shadow-inset-outline-ring)",
        "inset-primary-ring": "var(--shadow-inset-primary-ring)",
        /* The code field's error ring (CodeTextarea). */
        "error-ring-thin": "var(--shadow-error-ring-thin)",
        /* The underline field register (TextField). */
        "field-focus": "var(--shadow-field-focus)",
        "field-error": "var(--shadow-field-error)",
      },
      spacing: {
        micro: "var(--spacing-micro)",
        hairline: "var(--spacing-hairline)",
        tiny: "var(--spacing-tiny)",
        xxs: "var(--spacing-xxs)",
        "1-5": "var(--spacing-1-5)",
        "2-5": "var(--spacing-2-5)",
        "4-5": "var(--spacing-4-5)",
        "7-5": "var(--spacing-7-5)",
        "1-75": "var(--spacing-1-75)",
        "3-5": "var(--spacing-3-5)",
        12: "var(--spacing-12)",
        16: "var(--spacing-16)",
        24: "var(--spacing-24)",
        // The numeric scale rides the tokens too (overrides Tailwind's
        // hardcoded rem steps with the app's --spacing-N family).
        0: "var(--spacing-0)",
        1: "var(--spacing-1)",
        2: "var(--spacing-2)",
        3: "var(--spacing-3)",
        4: "var(--spacing-4)",
        5: "var(--spacing-5)",
        6: "var(--spacing-6)",
        7: "var(--spacing-7)",
        8: "var(--spacing-8)",
        9: "var(--spacing-9)",
        10: "var(--spacing-10)",
      },
      height: {
        xs: "var(--height-xs)",
        sm: "var(--height-sm)",
        md: "var(--height-md)",
        lg: "var(--height-lg)",
        xl: "var(--height-xl)",
        "2xl": "var(--height-2xl)",
        /* The icon canvas scale (widths registered under width). */
        "icon-xs": "var(--icon-size-xs)",
        "icon-sm": "var(--icon-size-sm)",
        "icon-md": "var(--icon-size-md)",
        "icon-lg": "var(--icon-size-lg)",
        "icon-xl": "var(--icon-size-xl)",
        "icon-2xl": "var(--icon-size-2xl)",
        /* The slider register (track thickness + the sm thumb). */
        tiny: "var(--spacing-tiny)",
        "shape-sm": "var(--shape-small)",
        "slider-thumb-sm": "var(--slider-thumb-size-sm)",
        /* Skeleton row heights (adaptive — they ride the element's font
           metrics via em, as the pre-catalog register did). */
        "skeleton-text": "var(--skeleton-text-height)",
        "skeleton-heading": "var(--skeleton-heading-height)",
        /* Separator thickness register (1px rides the default h-px). */
        "sep-md": "var(--border-width-thick)",
        "sep-lg": "var(--border-width-extra-thick)",
        "button-xs": "var(--height-button-xs)",
        "button-sm": "var(--height-button-sm)",
        "button-md": "var(--height-button-md)",
        "button-lg": "var(--height-button-lg)",
        "icon-only-visible-xs": "var(--button-icon-only-visible-xs)",
        "icon-only-visible-sm": "var(--button-icon-only-visible-sm)",
        "icon-only-visible-md": "var(--button-icon-only-visible-md)",
        "icon-only-visible-lg": "var(--button-icon-only-visible-lg)",
      },
      minHeight: {
        touch: "var(--button-min-height)",
        topbar: "var(--topbar-height)",
        "button-lg": "var(--height-button-lg)",
      },
      width: {
        panel: "var(--panel-width-md)",
        sidebar: "var(--sidebar-width)",
        /* The square box controls' twin of the height register (Checkbox,
           Radio): the box sides ride the same --height-N tokens, so `w-xs`
           and friends actually generate — without them twMerge keeps the
           caller's `w-xs` over the catalog's `w-icon-md`, the utility
           resolves to nothing, and the box renders a content-width
           rectangle instead of a square. */
        xs: "var(--height-xs)",
        sm: "var(--height-sm)",
        md: "var(--height-md)",
        "icon-xs": "var(--icon-size-xs)",
        "icon-sm": "var(--icon-size-sm)",
        "icon-md": "var(--icon-size-md)",
        "icon-lg": "var(--icon-size-lg)",
        "icon-xl": "var(--icon-size-xl)",
        "icon-2xl": "var(--icon-size-2xl)",
        /* The icon-only button visible box (the height register's twin —
           without it the width utility never generates and aspect-square
           alone carried the square, blowing up with min-h-touch). */
        "icon-only-visible-xs": "var(--button-icon-only-visible-xs)",
        "icon-only-visible-sm": "var(--button-icon-only-visible-sm)",
        "icon-only-visible-md": "var(--button-icon-only-visible-md)",
        "icon-only-visible-lg": "var(--button-icon-only-visible-lg)",
        /* The fraction scale (skeleton row widths). */
        "3-4": "75%",
        "2-3": "66%",
        half: "50%",
        "1-3": "33%",
        "1-4": "25%",
        "slider-thumb-sm": "var(--slider-thumb-size-sm)",
        /* Separator thickness register (1px rides the default w-px). */
        "sep-md": "var(--border-width-thick)",
        "sep-lg": "var(--border-width-extra-thick)",
      },
      maxWidth: {
        panel: "var(--panel-width-md)",
      },
      minWidth: {
        touch: "var(--button-min-height)",
        xs: "var(--height-xs)",
        sm: "var(--height-sm)",
        md: "var(--height-md)",
        /* The slider value column (the pre-catalog 2.5em, adaptive). */
        "slider-value": "2.5em",
      },
      backgroundImage: {
        /* The fleet loading-shimmer sweep (LoadingSkeleton). */
        shimmer:
          "linear-gradient(90deg, var(--md-sys-color-surface-container-high) 25%, var(--md-sys-color-surface-container-highest) 50%, var(--md-sys-color-surface-container-high) 75%)",
      },
      backgroundSize: {
        "sweep-200": "200% 100%",
      },
      animation: {
        shimmer:
          "shimmer var(--skeleton-shimmer-duration) var(--motion-easing-linear) infinite",
        /* The spinner arc register (0.8s linear, pre-catalog value). */
        "spinner-arc": "spinner-arc 0.8s var(--motion-easing-linear) infinite",
      },
      keyframes: {
        "spinner-arc": {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
      },
      opacity: {
        5: "var(--opacity-5)",
        6: "var(--opacity-6)",
        7: "var(--opacity-7)",
        10: "var(--opacity-10)",
        15: "var(--opacity-15)",
        25: "var(--opacity-25)",
        30: "var(--opacity-30)",
        35: "var(--opacity-35)",
        40: "var(--opacity-40)",
        45: "var(--opacity-45)",
        48: "var(--opacity-48)",
        50: "var(--opacity-50)",
        55: "var(--opacity-55)",
        60: "var(--opacity-60)",
        70: "var(--opacity-70)",
        75: "var(--opacity-75)",
        100: "var(--opacity-100)",
      },
      borderWidth: {
        DEFAULT: "var(--border-width-default)",
        medium: "var(--border-width-medium)",
        thick: "var(--border-width-thick)",
        "extra-thick": "var(--border-width-extra-thick)",
      },
      outlineWidth: {
        DEFAULT: "var(--border-width-thick)",
        thick: "var(--border-width-thick)",
      },
      ringWidth: {
        DEFAULT: "var(--border-width-thick)",
        thick: "var(--border-width-thick)",
      },
      outlineOffset: {
        micro: "var(--spacing-micro)",
        focus: "var(--focus-outline-offset)",
      },
      zIndex: {
        1: "var(--z-1)",
        2: "var(--z-2)",
        3: "var(--z-3)",
        5: "var(--z-5)",
        10: "var(--z-10)",
        15: "var(--z-15)",
        20: "var(--z-20)",
        30: "var(--z-30)",
        50: "var(--z-50)",
        dropdown: "var(--z-dropdown)",
        popover: "var(--z-popover)",
        "node-overlay": "var(--z-node-overlay)",
        "modal-backdrop": "var(--z-modal-backdrop)",
        modal: "var(--z-modal)",
        floating: "var(--z-floating)",
        tooltip: "var(--z-tooltip)",
      },
      transitionDuration: {
        instant: "var(--motion-duration-instant)",
        shorter: "var(--motion-duration-shorter)",
        short: "var(--motion-duration-short)",
        medium: "var(--motion-duration-medium)",
        long: "var(--motion-duration-long)",
      },
      transitionTimingFunction: {
        standard: "var(--motion-easing-standard)",
        emphasized: "var(--motion-easing-emphasized)",
        decelerate: "var(--motion-easing-decelerate)",
        accelerate: "var(--motion-easing-accelerate)",
        tactile: "var(--motion-easing-tactile)",
        collapse: "var(--motion-easing-collapse)",
      },
      transitionProperty: {
        card: "background-color, border-color, transform",
        colors: "background-color, border-color, color",
      },
      lineHeight: {
        /* The code field's line pitch (CodeTextarea). */
        code: "1.6",
      },
      tabSize: {
        2: "2",
      },
      scale: {
        press: "var(--tactile-press-scale)",
        card: "var(--scale-card-press)",
        /* The slider thumb's hover grow (the pre-catalog 1.15). */
        "thumb-grow": "1.15",
      },
    },
  },
  plugins: [],
} satisfies Config;
