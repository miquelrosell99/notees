/**
 * Design bridge fixture — /__design-bridge-fixture.
 *
 * Mounts the app's NORMALIZED catalog components with data-fix hooks so
 * the Playwright bridge spec (e2e/bridge-fixture.spec.ts, from the
 * rosellramos-design-system skill) can assert COMPUTED behavior across
 * themes, accent switches, and interaction states — token resolution,
 * contrast, the hover register, the focus ring, disabled dimming, the
 * busy announcement, and the dialog elevation/scrim.
 *
 * The page renders INSTEAD of the app (main.tsx branches on the pathname):
 * no auth, no sync server, no workspace — a deterministic surface. It is
 * not linked from anywhere; exclude it from any future sitemap.
 */
import { useState } from "react";

import "./app.css";
import { Button } from "../components/ui/fleet/Button.js";
import { ToggleSwitch } from "../components/ui/fleet/ToggleSwitch.js";
import { TextField } from "../components/ui/fleet/TextField.js";
import { Tabs } from "../components/ui/fleet/Tabs.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DesignBridgeFixture() {

  const [tab, setTab] = useState("a");
  const [switchOn, setSwitchOn] = useState(true);
  const [toggleOn, setToggleOn] = useState(false);
  const [checked, setChecked] = useState(true);

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-4)",
        padding: "var(--spacing-6)",
        background: "var(--md-sys-color-background)",
        minHeight: "100vh",
      }}
    >
      <section aria-label="buttons" style={{ display: "flex", gap: "var(--spacing-2)", flexWrap: "wrap" }}>
        <Button data-fix="btn-primary" variant="primary">Save</Button>
        <Button data-fix="btn-outline" variant="outline">Cancel</Button>
        <Button data-fix="btn-disabled" disabled>Disabled</Button>
        <Button data-fix="btn-loading" loading>Saving…</Button>
        <Button data-fix="btn-default" variant="default">Default</Button>
        <Button data-fix="btn-ghost" variant="ghost" icon="mdi mdi-cog" aria-label="Ghost settings" />
        <Button data-fix="btn-danger" variant="danger">Delete</Button>
        <Button data-fix="btn-danger-solid" variant="danger-solid">Destroy</Button>
      </section>

      <section aria-label="fields" style={{ display: "flex", gap: "var(--spacing-4)", alignItems: "flex-end", flexWrap: "wrap" }}>
        <TextField data-fix="text-field" label="Title" placeholder="Underlined field" />
        <Input data-fix="catalog-input" placeholder="Catalog input" aria-label="Catalog input" />
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-2)" }}>
          <Switch data-fix="catalog-switch" checked={switchOn} onCheckedChange={setSwitchOn} aria-label="Catalog switch" />
          Catalog switch
        </label>
        <ToggleSwitch
          data-fix="toggle-switch"
          size="md"
          leftLabel="Page"
          rightLabel="Block"
          checked={toggleOn}
          onChange={setToggleOn}
        />
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-2)" }}>
          <Checkbox data-fix="checkbox" checked={checked} onCheckedChange={(v) => setChecked(v === true)} aria-label="Fixture checkbox" />
          Checkbox
        </label>
        <Badge data-fix="badge">Badge</Badge>
      </section>

      <section aria-label="tabs" style={{ maxWidth: "var(--panel-width-md)" }}>
        <Tabs value={tab} onChange={setTab}>
          <Tabs.List variant="contained">
            <Tabs.Tab value="a" icon="mdi mdi-home">First</Tabs.Tab>
            <Tabs.Tab value="b">Second</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="a">First panel</Tabs.Panel>
          <Tabs.Panel value="b">Second panel</Tabs.Panel>
        </Tabs>
      </section>

      <section aria-label="card" style={{ maxWidth: "var(--panel-width-md)" }}>
        <Card data-fix="card">
          <CardHeader>
            <CardTitle>Catalog card</CardTitle>
          </CardHeader>
          <CardContent>Card body</CardContent>
        </Card>
      </section>

      {/* modal={false}: the fixture asserts computed styles, and a modal
          overlay would block the pointer-driven state checks (hover) on
          the buttons beneath it. Statically open: the spec only reads
          computed styles, and the dialog must survive focus moves during
          the state assertions. */}
      {/* The backdrop register pinned as a static swatch: Radix renders
          DialogOverlay only when the dialog is modal, and a modal overlay
          would block the spec's pointer-driven state checks (hover) on
          the buttons beneath it — the scrim assertion reads the same
          utility chain the catalog overlay uses. A small swatch, not
          full-bleed, so the captures stay readable. */}
      <div data-fix="dialog-backdrop" className="fixed bottom-4 right-4 w-16 h-10 rounded-item z-modal-backdrop bg-scrim opacity-48 pointer-events-none" aria-hidden="true" />
      <Dialog open modal={false}>
        <DialogContent
          data-fix="dialog"
          onEscapeKeyDown={(event) => event.preventDefault()}
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>Fixture dialog</DialogTitle>
            <DialogDescription>A normalized dialog on the catalog layer.</DialogDescription>
          </DialogHeader>
          <p>Dialog body</p>
          <DialogFooter>
            <Button variant="outline" type="button">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
