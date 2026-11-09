---
name: powerbi-dashboard-viz
description: Enterprise Power BI and Tableau grade visual elements for React analytics applications. Adds executive KPI cards with sparklines, interactive slicers, cross-filtering matrices, gauge meters, and structured visual cards without generic AI templates.
---

# Power BI Executive Visual Analytics System

When building data dashboards, incorporate these proven Power BI & Tableau visual patterns to achieve enterprise-grade polish:

## 1. Executive KPI Metric Scorecards
- **Structure:**
  - Category label (e.g., 'ANNUAL RAINFALL ANOMALY') in 11px uppercase tracking-wider text with a subtle info tooltip icon.
  - Big primary value (e.g., '1,248 mm') in bold 28px–32px font with tabular numerals (\ont-mono\ or \	abular-nums\).
  - Delta / Variance Pill: E.g., '▲ +14.2% vs 30-yr avg' with green/red semantic pill badge (\g-emerald-500/15 text-emerald-400\).
  - Integrated Micro-Sparkline: A compact 24px-high SVG line or area curve along the bottom of the card showing the multi-year trend at a glance.

## 2. Interactive Slicers & Filter Ribbons
- Horizontal segmented pill ribbons for fast multi-criteria slicing (Disaster Category, Season, Decade).
- Active slicers have a crisp, high-contrast fill with a subtle count indicator badge (e.g., \Floods (142)\).
- Clear 'Reset All Slicers' action in the ribbon corner.

## 3. Data Bar Matrix Tables (Visual Tables)
- Instead of raw text numbers in tables, include inline horizontal Data Bars inside cells (a proportional colored progress bar reflecting the relative value across rows).
- Sortable headers with ascending/descending directional indicators.
- Quick row-hover highlight that links to map cross-selection.

## 4. Visual Card Container Chrome
- Each chart and visual widget lives in a standardized Executive Card:
  - Header: Left title with icon + right action toolbar (Download CSV, Switch View [Table/Chart], Info tooltip).
  - Body: Visualization with padded margins and zero clipping.
  - Subtle crisp border (\order border-slate-800/80\) with a slight inner shadow for depth.

## 5. Synchronized Cross-Filtering
- Clicking a category in a breakdown chart or selecting a state on the map highlights related metrics across all other KPI tiles.
