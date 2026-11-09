---
name: geospatial-dashboard
description: Professional cartographic and geospatial data visualization standards for MapLibre, Leaflet, and scientific climate dashboards. Transforms flat, bland vector maps into high-impact, authentic NASA/Copernicus-grade intelligence interfaces without generic AI slop.
---

# Geospatial & Cartographic Design System

When designing interactive map dashboards and data visualizations, adhere to these professional cartographic standards:

## 1. Eliminate The 'Void Map' Look
- **Never render raw vector polygons over a plain blank background.** Flat polygons floating in an empty void look unfinished and bland.
- **Use High-Contrast Basemaps:**
  - Dark Mode: Integrate CARTO Dark Matter or Stadia Alidade Smooth Dark tiles (\https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png\).
  - Light Mode: Integrate CARTO Positron (\https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png\).
  - This provides authentic ocean bathymetry, coastlines (Arabian Sea, Bay of Bengal), and geographic context while keeping state polygons as the focal hero layer.

## 2. Scientific Colormaps (Choropleth)
- Avoid flat pastel washes or single-hue mud. Use perceptually uniform scientific color ramps:
  - **Precipitation / Water:** ColorBrewer YlGnBu (Light Gold -> Teal -> Deep Cobalt: \#EDF8B1\ -> \#7FCDBB\ -> \#1D91C0\ -> \#081D58\).
  - **Temperature / Heat:** Turbo or Magma (Deep Violet -> Amber -> Coral).
  - **No-Data Treatment:** Subtle hatched pattern or neutral slate (\#1E293B\ in dark, \#E2E8F0\ in light) with an explicit legend key.

## 3. Map Interactivity & HUD Styling
- **State Selection:** Selected polygons should have a double-ring glow: an inner crisp 2px line and an outer 6px soft halo (\#00F2FE\ or emerald \#10B981\).
- **Floating Controls (HUD):** Map controls (zoom, layer toggles, basemap switcher, legend) should float as a compact, translucent dark slate card (\g-slate-900/80 backdrop-blur-md border border-slate-700/50\) with crisp typography.
- **Micro-Tooltips:** Hovering over a state should show an instant, sleek card: State Name, Metric Value with bold tabular numbers, and a mini sparkline/delta pill.
