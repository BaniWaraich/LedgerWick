---
name: Ledgerwick
colors:
  surface: '#f8f9fa'
  surface-dim: '#d9dadb'
  surface-bright: '#f8f9fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f5'
  surface-container: '#edeeef'
  surface-container-high: '#e7e8e9'
  surface-container-highest: '#e1e3e4'
  on-surface: '#191c1d'
  on-surface-variant: '#45464e'
  inverse-surface: '#2e3132'
  inverse-on-surface: '#f0f1f2'
  outline: '#75777e'
  outline-variant: '#c6c6ce'
  surface-tint: '#525e7f'
  primary: '#182442'
  on-primary: '#ffffff'
  primary-container: '#2e3a59'
  on-primary-container: '#98a4c9'
  inverse-primary: '#bac6ec'
  secondary: '#585f6c'
  on-secondary: '#ffffff'
  secondary-container: '#dce2f3'
  on-secondary-container: '#5e6572'
  tertiary: '#002c1b'
  on-tertiary: '#ffffff'
  tertiary-container: '#00442d'
  on-tertiary-container: '#17bb83'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dae2ff'
  primary-fixed-dim: '#bac6ec'
  on-primary-fixed: '#0d1a38'
  on-primary-fixed-variant: '#3a4666'
  secondary-fixed: '#dce2f3'
  secondary-fixed-dim: '#c0c7d6'
  on-secondary-fixed: '#151c27'
  on-secondary-fixed-variant: '#404754'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#f8f9fa'
  on-background: '#191c1d'
  surface-variant: '#e1e3e4'
typography:
  display-lg:
    fontFamily: Source Serif 4
    fontSize: 48px
    fontWeight: '600'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Source Serif 4
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
  headline-lg-mobile:
    fontFamily: Source Serif 4
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Source Serif 4
    fontSize: 24px
    fontWeight: '500'
    lineHeight: 32px
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Hanken Grotesk
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Hanken Grotesk
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Hanken Grotesk
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.03em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  container-max: 1280px
  gutter: 24px
  margin-desktop: 40px
  margin-mobile: 16px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
---

## Brand & Style
The design system is rooted in the "Modern Institutional" aesthetic—a blend of traditional financial stability and contemporary software precision. It targets small business owners who require a tool that feels more like a dedicated financial partner than a fleeting startup app.

The brand personality is **calm, intelligent, and refined**. The visual language avoids all trends of the "hype cycle" (no neon, no heavy glassmorphism, no rounded "bubbly" buttons) in favor of a high-contrast, structured layout that prioritizes information density and clarity. The emotional response should be one of confidence and order, utilizing generous whitespace and a rigorous grid to signal that the user’s financial data is handled with meticulous care.

## Colors
The palette is intentionally restrained to maintain a professional, high-end atmosphere. 

- **Primary (Deep Indigo):** Used for navigation, primary actions, and brand identification. It provides a grounded, authoritative foundation.
- **Secondary (Slate Gray):** Utilized for supporting text, icons, and secondary UI elements to reduce visual noise.
- **Accent/Success (Sage/Emerald):** A sophisticated green used sparingly for positive financial indicators and specific growth-related callouts.
- **Functional Colors:** 
    - *Error:* A muted, deep crimson (#991B1B).
    - *Warning:* A desaturated amber (#B45309).
    - *Info:* A clean, cool blue (#1D4ED8).
- **Surface Strategy:** The system uses a "Paper & Ink" approach—bright white surfaces (#FFFFFF) against a subtle off-white background (#F9FAFB) to create depth without relying on heavy shadows.

## Typography
The typography strategy employs a "Hybrid Classic" approach. 

- **Headlines:** Source Serif 4 is used to evoke the authoritative feel of traditional financial ledgers and prestigious news publications. It provides a premium, intellectual weight to the UI.
- **Interface & Data:** Hanken Grotesk is the workhorse for all functional elements. Its sharp, contemporary geometry ensures maximum legibility in data-dense environments like tables and dashboards.
- **Hierarchy:** Use weight over color to establish importance. Data points (numbers) should always be set in Hanken Grotesk with tabular lining figures to ensure vertical alignment in columns.

## Layout & Spacing
The layout follows a **Fixed-Fluid Hybrid** model. The main content area is capped at 1280px to maintain line-length readability, centered on the screen. 

- **Grid:** A 12-column grid is used for desktop, 8-column for tablet, and 4-column for mobile.
- **Rhythm:** An 8px baseline grid dictates all vertical spacing. Elements should be separated by 16px (md) or 32px (lg) increments to ensure a spacious, professional feel.
- **Density:** While the branding is "spacious," data tables use a "Compact" vertical rhythm (8px padding) to allow users to view more financial records without excessive scrolling.
- **Mobile Reflow:** In mobile views, sidebar navigation must collapse into a bottom bar or a clean drawer, and multi-column forms must stack vertically to maintain tap-target integrity.

## Elevation & Depth
This design system avoids heavy shadows, instead using **Tonal Layers and Crisp Outlines** to define hierarchy.

- **Level 0 (Background):** #F9FAFB. The canvas.
- **Level 1 (Cards/Containers):** #FFFFFF. These use a 1px solid border in #E5E7EB. No shadow is applied to base cards to keep the UI flat and professional.
- **Level 2 (Modals/Popovers):** #FFFFFF. These utilize a highly diffused, low-opacity shadow (0px 10px 15px -3px rgba(0, 0, 0, 0.05)) to suggest they are floating above the workspace.
- **Interactions:** Use a subtle subtle shift in border-color (Primary Indigo) rather than an elevation change (lift) when a user interacts with a card or input.

## Shapes
The shape language is "Architectural." 

- **Standard Elements:** Buttons, inputs, and small containers use a 4px (0.25rem) radius. This provides a hint of modern accessibility while remaining serious and structured.
- **Large Containers:** Cards and dashboards use 8px (0.5rem) to slightly soften the large areas of the screen.
- **Strictness:** Avoid full pill shapes. Even tags and chips should maintain the 4px soft corner to ensure they don't look like consumer social media "bubbles."

## Components
Consistent styling across the application is governed by the following rules:

- **Buttons:** 
  - *Primary:* Solid Deep Indigo, white text, 4px radius. 
  - *Secondary:* Ghost style with Slate Gray border and text. 
  - *Size:* Standard height of 40px for desktop.
- **Data Tables:** The core of the product. Use a white background, 1px horizontal dividers in #F3F4F6, and a slightly darker header row (#F9FAFB). Text remains Slate Gray, but financial figures are Deep Indigo.
- **Input Fields:** 1px Slate border, 4px radius. On focus, the border transitions to Deep Indigo with a 2px outer "glow" in a 10% opacity version of the primary color.
- **Status Indicators:** 
  - Small circular dots (8px) or subtle background-tinted labels. 
  - *Success:* Sage text on light sage background. 
  - *Error:* Deep Crimson text on light pink background.
- **Cards:** Used to group financial metrics. Each card must have a clear "Source Serif 4" title and a large "Hanken Grotesk" metric value.
- **Lists:** Clean, no bullets. Use 12px padding between items with a light divider to maintain the "ledger" feel.