---
name: Modern Academic Knowledge Base
colors:
  surface: '#f7f9fb'
  surface-dim: '#d8dadc'
  surface-bright: '#f7f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f6'
  surface-container: '#eceef0'
  surface-container-high: '#e6e8ea'
  surface-container-highest: '#e0e3e5'
  on-surface: '#191c1e'
  on-surface-variant: '#434655'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f3'
  outline: '#747686'
  outline-variant: '#c4c5d7'
  surface-tint: '#2151da'
  primary: '#0037b0'
  on-primary: '#ffffff'
  primary-container: '#1d4ed8'
  on-primary-container: '#cad3ff'
  inverse-primary: '#b7c4ff'
  secondary: '#565e74'
  on-secondary: '#ffffff'
  secondary-container: '#dae2fd'
  on-secondary-container: '#5c647a'
  tertiary: '#623c00'
  on-tertiary: '#ffffff'
  tertiary-container: '#825100'
  on-tertiary-container: '#ffcb8f'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dce1ff'
  primary-fixed-dim: '#b7c4ff'
  on-primary-fixed: '#001551'
  on-primary-fixed-variant: '#0039b5'
  secondary-fixed: '#dae2fd'
  secondary-fixed-dim: '#bec6e0'
  on-secondary-fixed: '#131b2e'
  on-secondary-fixed-variant: '#3f465c'
  tertiary-fixed: '#ffddb8'
  tertiary-fixed-dim: '#ffb95f'
  on-tertiary-fixed: '#2a1700'
  on-tertiary-fixed-variant: '#653e00'
  background: '#f7f9fb'
  on-background: '#191c1e'
  surface-variant: '#e0e3e5'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 48px
    fontWeight: '800'
    lineHeight: 56px
    letterSpacing: -0.03em
  display-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '800'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  title-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: 0em
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0.005em
  label-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  space-2: 0.125rem
  space-4: 0.25rem
  space-8: 0.5rem
  space-12: 0.75rem
  space-16: 1rem
  space-20: 1.25rem
  space-24: 1.5rem
  space-32: 2rem
  space-48: 3rem
  space-64: 4rem
  gutter-sm: 1rem
  gutter-md: 1.5rem
  gutter-lg: 2rem
  margin-sm: 1rem
  margin-md: 2rem
  margin-lg: 3rem
---

## Brand & Style

This design system delivers an authoritative, scholarly, and modern learning environment tailored for young researchers, students, and educators. It merges collegiate rigor with contemporary digital precision, avoiding juvenile cartoonishness in favor of clear, empowering information architecture. 

The aesthetic style is **Corporate / Modern** anchored in academic publishing conventions: structured grid frameworks, crisp border delineation, high-contrast legibility, and refined typographical pacing. The emotional tone projects intellectual credibility, clarity, focus, and quiet encouragement—instilling confidence in young minds that they are engaging with real, verified knowledge.

## Colors

The palette establishes an authoritative academic hierarchy balanced by purposeful visual markers:

- **Primary Accent (`#1d4ed8` - Oxford Royal Blue):** The primary brand anchor used for interactive targets, active tabs, focused states, and key navigational paths.
- **Secondary (`#0f172a` - Deep Slate Navy):** Provides high-density structure. Deployed for primary headlines, dark navigational anchors, high-contrast toolbars, and dominant structural elements.
- **Tertiary (`#f59e0b` - Academic Amber/Gold):** Utilized strictly for badges, scholarly achievements, curation markers, alerts, and citation callouts.
- **Neutral Surface (`#f8fafc` - Crisp Cool White):** The foundational canvas providing a glare-free, clinical, and distractionless workspace.
- **Surface Elevation Steps:** Pure White (`#ffffff`) for elevated foreground cards; Slate-50 (`#f8fafc`) for base canvases; Slate-100 (`#f1f5f9`) for recessed wells; Slate-200 (`#e2e8f0`) for hairline dividers.
- **Text Hierarchies:** Slate-900 (`#0f172a`) for primary text; Slate-600 (`#475569`) for analytical body and citations; Slate-400 (`#94a3b8`) for metadata and microcopy.

## Typography

Typography pairs **Plus Jakarta Sans** for display, headings, and key categorizations with **Inter** for exhaustive body, dense metadata, and tabular information.

- **Plus Jakarta Sans** injects sculpted geometry, modern academic poise, and clarity without sterility. Headings feature tightened tracking (`-0.01em` to `-0.03em`) to anchor the eye across information-heavy layouts.
- **Inter** handles narrative comprehension, definitions, glossaries, and instructional microcopy, selected for its neutral metrics, expansive character set, and optical legibility at reduced font scales.
- High-density academic callouts (formulas, taxonomy codes, reference tags) leverage tabular figures and uppercase tracking on `label-sm`.

## Layout & Spacing

This layout adheres to a fixed-max-width multi-column model optimized for reading speed, reference documentation, and structured browsing:

- **Desktop (1200px+):** Max-width 1360px container, 12-column grid, `2rem` gutters, and `3rem` margins. Standard layout adopts an asymmetric 3-column academic model: navigation index (3 cols), primary reading/content (6 cols), and contextual reference/metadata (3 cols).
- **Tablet (768px – 1199px):** 8-column grid with `1.5rem` gutters and `2rem` margins. Collapses ancillary metadata beneath content; side navigation shifts into a slide-over panel.
- **Mobile (< 768px):** 4-column fluid grid, `1rem` gutters, `1rem` margins. Content reflows linearly; tables convert to structured key-value cards; header docks to top with sticky search.
- **Spacing Rhythm:** Strictly incremental 4px/8px base rhythm. Paragraph blocks adhere to a max-width of `68ch` to preserve comprehension.

## Elevation & Depth

Visual hierarchy avoids heavy drop shadows and soft, blurred realism, favoring structural discipline through **tonal layering and low-contrast borders**:

- **Hairline Dividers:** Primary depth is achieved using crisp 1px borders (`#e2e8f0`) rather than dramatic drop shadows. Cards, sidebars, and panels exist in explicit boundary frames.
- **Base Canvas:** The global background is fixed at `#f8fafc`. Interactive cards, drawers, and active work surfaces shift upward to crisp `#ffffff`.
- **Structural Elevation:**
  - *Resting Cards / Panels:* `#ffffff` background with a solid `1px solid #e2e8f0` stroke; no shadow.
  - *Interactive / Hovered Cards:* Retains the `1px solid #cbd5e1` stroke, paired with an ambient micro-shadow: `0 2px 4px -1px rgba(15, 23, 42, 0.04), 0 1px 2px -1px rgba(15, 23, 42, 0.03)`.
  - *Floating Menus & Popovers:* `#ffffff` background, `1px solid #cbd5e1`, overlaid with an authoritative elevation shadow: `0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.04)`.

## Shapes

The design system employs a crisp, surgical corner language with a unified `roundedness` level of **1** (`0.25rem` / `4px` base to `0.5rem` / `8px` maximum).

- **Core Interactive Controls:** Buttons, inputs, search bars, chips, and dropdown toggles use a tight `6px` radius (`0.375rem`).
- **Containers & Surfaces:** Main content cards, code blocks, reference panels, and modals use an `8px` radius (`0.5rem`).
- **Micro-Indicators:** Badges, breadcrumbs, and tags adhere strictly to `4px` (`0.25rem`), preserving an editorial, systematic, and printed-journal sensibility. Rounded pills and full circular corners are disallowed except for user avatar cutouts.

## Components

- **Buttons:**
  - *Primary:* Oxford Royal Blue background (`#1d4ed8`), text `#ffffff`, radius `6px`, hairline border `1px solid #1e40af`. Hover darkens to `#1e40af`. Focus rings display a 2px offset outline using `#93c5fd`.
  - *Secondary:* `#ffffff` background, text `#0f172a`, border `1px solid #cbd5e1`. Hover shifts surface to `#f8fafc` and border to `#94a3b8`.
  - *Tertiary / Accent:* Pale amber background (`#fef3c7`), text `#92400e`, border `1px solid #fde68a`. Used exclusively for study milestones and save-to-notebook triggers.

- **Chips & Badges:**
  - *Topic Chips:* Background `#f1f5f9`, border `1px solid #e2e8f0`, text `#334155`, radius `4px`, font `label-sm`.
  - *Academic Level Badges:* Background `#fffbeb`, border `1px solid #fcd34d`, text `#b45309`, uppercase tracking `0.04em`.

- **Input Fields & Search Bars:**
  - Background `#ffffff`, border `1px solid #cbd5e1`, radius `6px`, text `#0f172a`, font `body-md`.
  - Focused state transitions border to `#1d4ed8` with a precise `0 0 0 3px rgba(29, 78, 216, 0.12)` halo. Placeholder text uses `#94a3b8`.

- **Cards (Knowledge Articles & Directory):**
  - Background `#ffffff`, border `1px solid #e2e8f0`, radius `8px`, padding `1.5rem`.
  - Header displays topic breadcrumbs in `label-sm` with color `#64748b`, title in `headline-sm`, and summary in `body-md`. Top-edge category accent bars (2px thick) denote discipline (e.g., Royal Blue for Physics, Amber for History).

- **Lists & Data Tables:**
  - List items are separated by `1px solid #f1f5f9`. Hover rows show `#f8fafc`.
  - Tables utilize Slate-100 (`#f1f5f9`) header backgrounds, `label-sm` uppercase text (`#475569`), and explicit `1px solid #e2e8f0` grid lines.

- **Checkboxes & Radios:**
  - Square boxes (`18px × 18px`) with `4px` radius; border `1.5px solid #94a3b8`. Checked state fills `#1d4ed8` with a white geometric check icon. Radios use identical metrics with circular geometries.

- **Specialized Academic Components:**
  - *Citation / Reference Callout:* Recessed Slate-50 panel with a 3px vertical border on the left (`#1d4ed8`), indented `1rem`, body text `body-sm`.
  - *Glossary Tooltip Target:* Dotted underline `1.5px solid #1d4ed8`, cursor `help`, popping a high-contrast `#0f172a` tooltip with `#f8fafc` text.