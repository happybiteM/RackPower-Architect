# RackPower Architect

**Rack & PDU Power Planning Tool** — a browser-based application for data-center and AV professionals to plan rack layouts, configure vertical and rack-mounted PDUs, calculate power distribution, and visualize device/PDU placement from multiple perspectives.

Built with React 19 + TypeScript + Vite. No backend required — everything runs client-side, so project data never leaves your machine.

---

## Feature Overview

### 1. Device Import & Data Management
- **CSV import** with a downloadable template (room, device, rack U height, PSU count, typical/max wattage, power connection type).
- Heavy CSV parsing is offloaded to a **Web Worker** (`utils/csvParser.worker.ts`) to keep the UI responsive on large datasets.
- Full **JSON configuration export/import** round-trip with schema validation to prevent malformed or hostile data.
- Devices are grouped per room/rack; unmounted devices appear in a **virtualized list** (react-window) that scales to thousands of rows.

### 2. Global Configuration (single source of truth)
The Global Config panel defines everything both diagram views draw from:
- **Rack size**: preset catalogue from 6U wall-mount up to 48U full-height (external width/height/depth in cm, usable U count), plus custom dimensions.
- **Component dimensions**: configurable physical width/height/depth (cm) per device type; horizontal PDU body height is configured in **U**, with only **depth** configurable in cm.
- **Vertical (zero-U) PDUs**: socket type/count, strip length in cm, quantity, inlet & power parameters. Hang in the rear left/right cable channels — non-overlapping, total length must fit within rack height.
- **Rack-mounted (horizontal) PDUs**: socket type/count, body height in U, depth in cm, faceplate width, socket column layout, default mounting rail (front/back), quantity.
- **PDU power input configuration** (shared by vertical and horizontal PDUs): inlet type (C14 / C20 / IEC-309 16A / IEC-309 32A / Hardwired), supply voltage, rated current per phase, single/three-phase, number of branch circuits, upstream breaker rating — with live VA/kW capacity calculation and wire-size/breaker guidance (IEC/NEC-style reference values).
- Placement strategy selector (**bottom / top / center**) and manual overrides.

### 3. Automatic PDU Placement Engine (`utils/placement.ts`)
- EIA-310-D geometry: 1U = 44.45 mm, standard rail offsets.
- Converts each horizontal PDU's body height + **cord-bend clearance** (per inlet type) into whole U slots.
- Scans real device U-spans to find collision-free positions, then applies the chosen strategy (default: bottom of rack, back rail).
- Packs vertical zero-U PDUs into the left/right rear channels, enforcing no overlap and total-length ≤ rack height.
- Emits info/warning/error diagnostics (e.g., not enough free U, channel overflow, breaker over-limit).
- Manual placements from the side view override auto-placement while still being validated.

### 4. Three Visualization Views
- **Front Rack View** (`RackVisualizer.tsx`): U-by-U rack elevation with color-coded A/B feed cabling, PDU strips, load indicators, and drag-and-drop device mounting. Virtualized unmounted-devices tray.
- **Side View** (`RackSideView.tsx`): true-to-scale depth cross-section of the rack showing front vs. rear rails. Devices and horizontal PDUs are drawn at their configured depths and can be **drag-and-dropped** onto any U position and rail (front/back). Vertical PDUs are intentionally omitted here (they occupy zero U); they appear in the rear-channel view instead. No cable clutter in this view — it is purely for space planning.
- **Wiring Diagram** (`WiringDiagram.tsx`): logical A/B PDU-pair to device/PSU connection map.

### 5. Power Distribution & Optimization (`utils/optimizer.ts`)
- Dual-feed (A/B) PDU pairing with per-PDU load accumulation.
- Bin-packing optimization balances typical/max loads across PDU pairs and flags devices that cannot be assigned.
- PDU utilization bars with capacity warnings.

### 6. Reports Tab
- Centered, print-friendly report area containing:
  - **Bill of Materials** (devices per room, U height, PSU count, typical/max watts, Feed A/B assignment).
  - **PDU Load Balance** table with utilization percentages.
  - Rack/PDU summary including placement warnings.

### 7. Export Options
- **PNG** (html-to-image) and **PDF** (jsPDF) of the rack diagram.
- **HTML report** export (sanitized with DOMPurify).
- **JSON config** export/import and **CSV template** download.
- Print stylesheet support.

### 8. UX & Accessibility
- Tabbed workspace (Config / Wiring View / Reports) with keyboard navigation and persisted state.
- **Dark/Light theme** toggle (CSS variables, persisted to localStorage); diagrams export on a consistent paper background.
- Toast notifications (react-toastify) replace alert/console error handling.
- ARIA roles/labels on tabs, dialogs, inputs, tables, and progress bars; labeled modal import preview.

### 9. Security Hardening
- HTML-entity sanitization of all CSV/config string inputs.
- DOMPurify on generated HTML exports.
- JSON schema validation with numeric range checks on import.
- File-extension + content validation; `crypto.randomUUID()` IDs; Object URLs revoked after downloads.

---

## Getting Started

```bash
npm install
npm run dev       # local development server
npm run build     # production build (dist/)
npm run preview   # serve the production build
```

Type-check only:

```bash
npx tsc --noEmit
```

## Project Structure

```
components/
  Dashboard.tsx        # main app shell, global config, tabs, state management
  RackVisualizer.tsx   # front rack elevation + virtualized device tray
  RackSideView.tsx     # depth cross-section with drag-and-drop U/rail placement
  WiringDiagram.tsx    # logical PDU→device cabling map
utils/
  placement.ts         # PDU placement engine (U math, clearance, channel packing)
  optimizer.ts         # A/B PDU pair load balancing
  csvParser.ts         # CSV import + input sanitization
  csvParser.worker.ts  # Web Worker wrapper for parsing
  theme.ts             # dark/light theme hook
types.ts               # domain model: Device, PDUConfig, PduType, rack sizes, placement I/O
constants.ts           # CSV template & defaults
```

## Tech Stack

React 19 · TypeScript 5.8 · Vite 6 · lucide-react · react-window (v2) · react-toastify · html-to-image · jsPDF · dompurify

## Notes & Limitations

- Wire-size and breaker guidance values are indicative reference figures for planning purposes; always verify final designs against local electrical codes (NEC / IEC / BS 7671) and a licensed electrician.
- All state is held in the browser; use **Export Config** to save projects.
