/**
 * Bridge fixture — proves the shadcn bridge COMPUTED-BEHAVIORALLY, not just
 * by token reference (rosellramos-design-system → components/shadcn-bridge.md).
 * A component can cite the right CSS variable and still inherit a library
 * default, break on an accent switch, or render wrong contrast in dark mode —
 * this spec catches that.
 *
 * Adapted from the skill's assets/templates/bridge-fixture.spec.ts.template
 * to the app's accent register (margin/brown/teal/blue/monochrome — the
 * template's "green" preset is not a Notees accent).
 *
 * The fixture page (/__design-bridge-fixture, src/ui/DesignBridgeFixture.tsx)
 * renders instead of the app — no auth, no sync server. Run:
 *   pnpm --filter @notees/web exec playwright test
 *
 * CI: this spec runs on every push that touches components/ or styles.
 */
import { test, expect } from '@playwright/test';

const FIXTURE = '/__design-bridge-fixture';

async function token(page, name) {
  return page.evaluate((n) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

async function contrast(page, fg, bg) {
  return page.evaluate(([f, b]) => {
    const parse = (s) => {
      const m = s.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const lum = ([r, g, b]) => {
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const A = parse(f), B = parse(b);
    if (!A || !B) return null;
    const [l1, l2] = [lum(A), lum(B)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  }, [fg, bg]);
}

const THEME_SCENARIOS = [
  { theme: 'dark', accent: null, label: 'dark' },
  { theme: 'light', accent: null, label: 'light' },
  { theme: 'dark', accent: 'teal', label: 'dark+accent-switch' },
];

async function themeMatrix(page) {
  for (const scenario of THEME_SCENARIOS) {
    await page.evaluate(([theme, accent]) => {
      document.documentElement.setAttribute('data-theme', theme);
      if (accent) document.documentElement.setAttribute('data-accent', accent);
      else document.documentElement.removeAttribute('data-accent');
    }, [scenario.theme, scenario.accent]);
    await page.waitForTimeout(150); // let transitions settle
    await runAssertions(page, scenario.label);
  }
}

async function runAssertions(page, label) {
  const primary = await token(page, '--md-sys-color-primary');
  const onPrimary = await token(page, '--md-sys-color-on-primary');
  const hoverOverlay = await token(page, '--md-sys-color-hover-overlay');
  const scrim = await token(page, '--md-sys-color-scrim');

  // 1. computed values resolve to tokens — a library default fails here
  const btnBg = await page.locator('[data-fix="btn-primary"]').evaluate(
    (el) => getComputedStyle(el).backgroundColor);
  expect(normalize(btnBg), `${label}: primary button bg resolves to the seed`).toBe(normalize(primary));

  const btnColor = await page.locator('[data-fix="btn-primary"]').evaluate(
    (el) => getComputedStyle(el).color);
  expect(normalize(btnColor), `${label}: primary button fg resolves to on-primary`).toBe(normalize(onPrimary));

  // 2. contrast of the designed pair ≥ 4.5:1 in every theme
  const ratio = await contrast(page, btnColor, btnBg);
  expect(ratio, `${label}: primary/on-primary contrast ≥ 4.5 (got ${ratio?.toFixed(2)})`).toBeGreaterThanOrEqual(4.5);

  // 3. interaction states
  await page.locator('[data-fix="btn-outline"]').hover();
  await page.waitForTimeout(120);
  const outlineHover = await page.locator('[data-fix="btn-outline"]').evaluate(
    (el) => getComputedStyle(el).backgroundColor);
  expect(normalize(outlineHover), `${label}: hover is the state-layer overlay (hover register)`).toBe(normalize(hoverOverlay));

  await page.locator('[data-fix="btn-primary"]').focus();
  const ring = await page.locator('[data-fix="btn-primary"]').evaluate((el) => {
    const s = getComputedStyle(el);
    return s.boxShadow || s.outline;
  });
  expect(ring, `${label}: focus ring present (never suppressed)`).not.toBe('none');

  const disabledOpacity = await page.locator('[data-fix="btn-disabled"]').evaluate(
    (el) => getComputedStyle(el).opacity);
  expect(Number(disabledOpacity), `${label}: disabled visibly dimmed`).toBeLessThan(0.75);

  const busy = await page.locator('[data-fix="btn-loading"]').getAttribute('aria-busy');
  expect(busy, `${label}: loading state announces aria-busy`).toBe('true');

  // 4. dialog rides the elevation + scrim registers
  const dialogShadow = await page.locator('[data-fix="dialog"]').evaluate(
    (el) => getComputedStyle(el).boxShadow);
  expect(dialogShadow, `${label}: dialog shadow present (elevation-3)`).not.toBe('none');
  const backdrop = await page.locator('.dialog-overlay, [data-fix="dialog-backdrop"]').evaluate(
    (el) => getComputedStyle(el).backgroundColor).catch(() => null);
  if (backdrop) expect(normalize(backdrop), `${label}: backdrop resolves to scrim`).toBe(normalize(scrim));
}

function normalize(color) {
  // Cross-format comparison: hex tokens (the raw custom-property values),
  // legacy rgb(a)(r, g, b, a), and CSS Color 4 space-separated
  // (`r g b / a%` — how color-mix values serialize from getPropertyValue)
  // all reduce to `r,g,b,a` with alpha as a 0–1 decimal.
  const hex3 = color.match(/^#([0-9a-f]{3})$/i);
  if (hex3) {
    return hex3[1]!.split('').map((c) => parseInt(c + c, 16)).join(',') + ',1';
  }
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1`;
  }
  const numbers = color.match(/[\d.]+%?/g) ?? [];
  if (numbers.length < 3) return color.replace(/\s/g, '');
  const channel = (s: string) => (s.endsWith('%') ? (parseFloat(s) * 255) / 100 : parseFloat(s));
  const alpha =
    numbers.length >= 4
      ? numbers[3]!.endsWith('%')
        ? parseFloat(numbers[3]!) / 100
        : parseFloat(numbers[3]!)
      : 1;
  return `${Math.round(channel(numbers[0]!))},${Math.round(channel(numbers[1]!))},${Math.round(channel(numbers[2]!))},${alpha}`;
}

test('bridge: computed behavior across themes, accent switch, and states', async ({ page }) => {
  await page.goto(FIXTURE);
  // Deterministic readiness: the fixture's primary button is the last
  // thing the module graph needs before the components are interactive
  // (networkidle races the vite dev stream's websocket).
  await page.locator('[data-fix="btn-primary"]').waitFor();
  await themeMatrix(page);
});

test('bridge: accent seam drives catalog components', async ({ page }) => {
  await page.goto(FIXTURE);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const before = normalize(await page.locator('[data-fix="btn-primary"]').evaluate(
    (el) => getComputedStyle(el).backgroundColor));
  await page.evaluate(() => document.documentElement.setAttribute('data-accent', 'blue'));
  await page.waitForTimeout(150);
  const after = normalize(await page.locator('[data-fix="btn-primary"]').evaluate(
    (el) => getComputedStyle(el).backgroundColor));
  expect(after, 'accent switch re-themes the catalog component through the alias layer').not.toBe(before);
});
