---
name: Unmix
colors:
  background: "#0e0d15"
  surface: "#16141f"
  surface-raised: "#1e1b2b"
  hairline: "#2b2840"
  text-primary: "#f3f1fa"
  text-muted: "#9a95b2"
  text-faint: "#5d5875"
  primary: "#f3f1fa"
  on-primary: "#0e0d15"
  stem-voice: "#ff6f91"
  stem-drums: "#ffb547"
  stem-bass: "#6d93ff"
  stem-other: "#3fd1b5"
  error: "#ff6f91"
  success: "#3fd1b5"
fonts:
  display: "Bricolage Grotesque"
  body: "Instrument Sans"
  mono: "JetBrains Mono"
roundness: "large"
---

# Design System: Unmix

## 1. Visual Theme & Atmosphere

Unmix feels like a mixing desk in a dark room: near-black violet surfaces, hairline dividers, and colour that appears only where there is signal. The product's single idea is that one sound fans out into four, so the four stem colours are the entire brand. They are never decoration for its own sake: they mark vocals, drums, bass and other, or a single gradient that sweeps through all four on a key word.

Layouts are confident and editorial rather than template-like. Display type is enormous and tight, supporting copy is plain and specific, and generous space does the work that drop shadows and boxes do elsewhere. It is dark-first, with an equally considered light theme.

## 2. Color Palette & Roles

### Primary Foundation
- **Midnight Violet** (#0e0d15): page background.
- **Studio Panel** (#16141f): cards, form panels, the drop zone.
- **Raised Control** (#1e1b2b): inputs, chips, segmented control tracks.
- **Hairline** (#2b2840): 1px borders and dividers.

### Accent & Interactive
- **Soft White** (#f3f1fa): primary buttons with Midnight Violet text. The primary action is deliberately not coloured.
- **Stem gradient**: Vocal Rose (#ff6f91) → Drum Amber (#ffb547) → Bass Blue (#6d93ff) → Other Teal (#3fd1b5). Used at most once per view, on a key word or the featured plan's border.

### Typography & Text Hierarchy
- **Soft White** (#f3f1fa): headings and body.
- **Muted Lilac** (#9a95b2): supporting copy.
- **Faint Lilac** (#5d5875): fine print and disabled text only.

### Functional States
- **Error**: Vocal Rose (#ff6f91). **Success**: Other Teal (#3fd1b5). **Warning**: Drum Amber (#ffb547).

## 3. Typography Rules

### Hierarchy & Weights
- **Display** (Bricolage Grotesque 800): 40 to 88px, line-height .95, tracking -.035em.
- **Section heading** (Bricolage Grotesque 700): 22 to 44px, line-height 1.1, tracking -.02em.
- **Body** (Instrument Sans 400 and 600): 15px, line-height 1.55.
- **Data** (JetBrains Mono 400 to 500): times, prices, usage counts, with tabular numerals.

### Spacing Principles
Headings stay tight, body stays relaxed, and text blocks stop at about 52 characters wide.

## 4. Component Stylings

### Buttons
Fully rounded pills. Primary is Soft White on Midnight Violet and lifts 2px on hover. Secondary is a Studio Panel fill with a hairline border that brightens on hover.

### Cards & Pricing Plans
18px radius, 1px hairline border, Studio Panel fill, almost no shadow. The featured plan has a 1px stem-gradient border and a soft ambient glow.

### Navigation
Slim transparent header with the waveform logo on the left, a few text links, and sign-in plus a pill call to action on the right. Collapses to a compact menu on phones.

### Inputs & Forms
12px radius, Raised Control fill, hairline border, 46px minimum height. Focus shows a 2px Vocal Rose outline. Errors appear as plain text under the field and never rely on colour alone.

### Stem Lanes
The signature component: horizontal lanes with a coloured square marker, a label and a waveform in that stem's colour, stacked and divided by hairlines.

## 5. Layout Principles

### Grid & Structure
1120px maximum content width. Twelve-column thinking with asymmetric splits such as 7/5. Sign-up uses a split layout with the form on one side and a stem-lane visual on the other.

### Whitespace Strategy
8px base unit, 96 to 120px between sections on desktop and 56 to 72px on phones.

### Alignment & Visual Balance
Left-aligned by default. Centre alignment is reserved for short conversion moments.

### Responsive Behavior & Touch
16px page gutter on phones, no horizontal scrolling, single column below 720px, 44px minimum touch targets.

## 6. Design System Notes for Stitch Generation

### Language to Use
"Dark mixing-desk atmosphere", "hairline dividers", "colour only where there is signal", "editorial oversized headline", "pill buttons".

### Avoid
Stock photos of people, purple-to-blue gradient backgrounds, glassmorphism, three identical icon cards, invented testimonials, customer logos or usage statistics. Unmix has no customers yet, so social proof must not be fabricated.

### Incremental Iteration
Generate one screen at a time, then refine with targeted edits rather than regenerating.
