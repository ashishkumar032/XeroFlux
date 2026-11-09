---
name: anti-slop
description: Strict frontend anti-slop guardrails for modern React, Tailwind, and Web applications. Eliminates generic AI tropes, blurry glassmorphism, floating pill badges, and copy-paste cards in favor of production-grade human craftsmanship.
---

# Anti-Slop Frontend Guardrails

When generating frontend code, React components, CSS, or Tailwind layouts, adhere strictly to these anti-slop rules.

## 1. Zero Tolerance for AI Slop Tropes
- **NO Generic Gradients:** Never use purple-to-indigo, cyan-to-purple, or neon gradient backgrounds. Avoid \g-gradient-to-r from-purple-500 to-indigo-600\ on buttons or headers.
- **NO Blurry Background Blobs:** Do not inject floating blurred circles (\lur-3xl\, glowing neon colored radial gradients) behind cards.
- **NO 3-Tier Cookie-Cutter Cards:** Do not divide content into three identical cards with a centered icon, bold title, and two lines of filler text.
- **NO Over-Rounded Pill Everywhere:** Avoid ounded-full\ on every button, badge, and input. Use structured radii (ounded-md\ or ounded-lg\, 6px–8px).
- **NO Faux macOS Window Dots:** Never add decorative fake red/yellow/green window dots unless explicitly asked for a terminal mockup.

## 2. Real Human UI Craftsmanship
- **High Information Density:** Dashboards and tools should feel like Linear, Vercel, Raycast, or Stripe. High signal-to-noise ratio, crisp borders (\order border-slate-800\ or \order-neutral-200\), compact paddings.
- **Asymmetric & Editorial Hierarchy:** Break monotonous grids. Pair wide data visualizers with narrow stat sidebars. Left-align text by default.
- **Intentional Color Palette:** 
  - Base: Solid crisp background (e.g., slate-950 or clean off-white), subtle surface cards (\g-slate-900/50\ or \g-white\).
  - Accent: One single deliberate accent color with purpose (e.g., emerald green, teal, or amber).
  - Status: Colors must be semantic (red = critical anomaly, yellow = warning, green = nominal).

## 3. Typography & Microcopy
- Choose clean, legible typography with stark weight contrast (e.g., bold tracking-tight headings with crisp tabular numbers for metrics).
- Use tabular numerals (\ont-mono\ or \	abular-nums\) for metrics, timestamps, and coordinates.
- Realistic Copy: Never write generic marketing filler like 'Empowering your seamless future'. Write exact domain terminology (e.g., 'Historical Cyclone Tracking', '95th Percentile Precipitation Anomaly').
