# App Store Listing Artwork — Practitioner Protocols

This directory contains the listing artwork assets for the **Practitioner Protocols** Shopify App Store listing.

> **Honesty & Transparency Disclosure:** These artwork assets were AI-generated using Google's **Imagen 3** generative image model on 2026-10-31, and post-processed to exact pixel dimensions. In strict accordance with Shopify App Store requirements (Rules 4.4.4 and 4.4.5), these assets do not contain screenshots, fake UI mockups, text baked into images, Shopify brand marks, or medical claims. Real in-app screenshots will be captured directly from the live application.

---

## 1. App Icon (`app-icon-1200.png`)

- **File:** `app-icon-1200.png`
- **Dimensions:** 1200 × 1200 px (1:1 square)
- **Format:** PNG (solid RGB background, `hasAlpha: no`)
- **Model Used:** Imagen 3
- **Generation Date:** 2026-10-31
- **Color Palette:** Deep teal (`#0F5C5C`), warm off-white (`#F7F5F0`), terracotta accent (`#E07A5F`)
- **Generation Prompt:**
  > "Minimalist vector app icon on solid deep teal (#0F5C5C) background. Three horizontal rounded off-white checklist pill bars stacked cleanly, converging into a simple geometric shopping bag silhouette. Subtle terracotta accent dot/badge. High contrast, clean geometric flat shapes, ~10% margin padding. No text, no letters, no words, no medical cross, no Shopify logo or bag mark, no people, no screenshots, solid background without transparency."
- **Shopify Specs Compliance:**
  - Square 1200 × 1200 px with ~10% edge padding for Shopify's dynamic corner rounding.
  - High-contrast, iconic geometry designed for crisp legibility at 64 × 64 px favicon / store listing scales.
  - Zero text, letters, medical crosses, or Shopify logos.

---

## 2. Feature Image (`feature-image-1600x900.png`)

- **File:** `feature-image-1600x900.png`
- **Dimensions:** 1600 × 900 px (16:9 aspect ratio)
- **Format:** PNG (solid RGB background, `hasAlpha: no`)
- **Model Used:** Imagen 3
- **Generation Date:** 2026-10-31
- **Alt Text (Factual):**
  > "A curated list of generic unbranded wellness products converging into a single shopping bag."
- **Generation Prompt:**
  > "Wide 16:9 minimalist vector banner artwork featuring generic unbranded product silhouettes (dropper, cream jar, bottle) connected through stylized off-white checklist protocol lines and terracotta accents into a sleek shopping bag emblem on a solid deep teal background. Solid clean background with contrast >= 4.5:1. No text, no fake UI, no Shopify logo, no medical cross, no people, no pricing, no star ratings."
- **Shopify Specs Compliance:**
  - Standard 1600 × 900 px (16:9) banner format.
  - High contrast ratio (> 4.5:1) between foreground elements and solid background.
  - Expands upon the core checklist-to-cart concept rather than duplicating the icon alone (Rule 4.4.4).
  - Contains no baked-in marketing copy, statistics, pricing, testimonials, or brand names.

---

## 3. Verification Report (`sips`)

```bash
sips -g pixelWidth -g pixelHeight -g hasAlpha app-icon-1200.png feature-image-1600x900.png
```
- `app-icon-1200.png`: `pixelWidth: 1200`, `pixelHeight: 1200`, `hasAlpha: no` (Exact match, solid background)
- `feature-image-1600x900.png`: `pixelWidth: 1600`, `pixelHeight: 900`, `hasAlpha: no` (Exact match, solid background)
