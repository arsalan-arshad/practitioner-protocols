# App Store Listing Artwork — Practitioner Protocols (v2)

This directory contains the listing artwork assets for the **Practitioner Protocols** Shopify App Store listing.

> **Honesty & Transparency Disclosure:** These artwork assets were produced on 2026-11-04 as part of the Brand Assets v2 refresh. The text-free base artwork was generated using Google's **Imagen 3** (`generate_image`) generative image model, and processed to exact pixel dimensions. In strict accordance with Shopify App Store requirements (Rules 4.4.4 and 4.4.5), these listing assets contain zero text, zero letters/numbers, zero Shopify brand marks or bag glyphs, zero clinical or medical claims, and zero human figures or faces.
>
> **Note on Listing Screenshots:** Shopify App Store rules require 3–6 real UI screenshots (1600 × 900 px) demonstrating the actual merchant admin and practitioner portal in operation. In compliance with Rule 4.4.4, screenshots must be authentic captures of the running software rather than illustrations or mockups; these will be captured directly from the live application and dev store during the final release phase.

---

## 1. App Icon (`app-icon-1200.png`)

- **File:** `app-icon-1200.png`
- **Dimensions:** 1200 × 1200 px (1:1 square)
- **Format:** PNG (sRGB color space, solid background)
- **Model Used:** Gemini Imagen 3 (`generate_image`)
- **Generation Date:** 2026-11-04
- **Alt Text (Factual):**
  > "Practitioner Protocols app icon: stacked offset rounded cards converging into a central coral rounded-square QR node on a deep teal background."
- **Generation Prompt:**
  > "Minimalist vector app icon on solid deep teal (#0B3C3D) background. Stacked offset rounded protocol cards in warm off-white (#FAF8F5) and mint (#7AE5B8) converging symmetrically into a bold central coral (#E76F51) rounded-square QR node with 3-corner finder pattern mark. Symmetrical, centered subject, ~15% margin padding, high contrast (>= 4.5:1), clean flat shapes. Strictly NO text, NO letters, NO words, NO shopping bag, NO bag handles, NO Shopify logo, NO medical cross, NO pills, NO human figures, NO smiling curves."
- **Shopify Specs Compliance:**
  - Square 1200 × 1200 px with ~15% edge padding for dynamic corner rounding on mobile and desktop App Store surfaces.
  - High-contrast geometry tested for legibility down to 32 × 32 px favicon and 64 × 64 px dashboard scales.
  - Zero text, zero bag silhouettes, zero medical crosses, zero logo lookalikes.

---

## 2. Feature Image (`feature-image-1600x900.png`)

- **File:** `feature-image-1600x900.png`
- **Dimensions:** 1600 × 900 px (16:9 aspect ratio)
- **Format:** PNG (sRGB color space, solid background)
- **Model Used:** Gemini Imagen 3 (`generate_image`)
- **Generation Date:** 2026-11-04
- **Alt Text (Factual):**
  > "A curated list card of generic unbranded wellness products (dropper bottle, cream jar, cosmetic tube, box) converging via a vector connector line into a single coral QR code link node on deep teal background."
- **Generation Prompt:**
  > "Calm, premium 16:9 minimalist vector banner artwork on solid deep teal (#0B3C3D) background. In the center, safely within the central 80% margins, a horizontal clean off-white rounded protocol card displays a row of 4 generic unbranded product silhouettes (dropper bottle, cream jar, lotion tube, rectangular carton box) in soft mint and warm sand. A clean straight vector connector line flows from the card to the right, terminating in a glowing coral (#E76F51) rounded-square QR node. Strictly NO text, NO letters, NO words, NO shopping bag, NO shopping cart, NO bag handles, NO Shopify logo, NO medical cross, NO healthcare symbols, NO human figures, NO smile-like curves, NO ratings, NO pricing."
- **Shopify Specs Compliance:**
  - Standard 1600 × 900 px (16:9) banner format.
  - All visual content positioned strictly within the central 80% safe zone.
  - High contrast ratio (> 4.5:1, measured > 11:1) between foreground elements and deep teal background.
  - Contains no baked-in marketing copy, statistics, pricing, testimonials, or brand names.

---

## 3. Sampled Hex Color Palette

Measured directly from the final PNG files:
- **Deep Teal (Background):** `#09484D` (icon) / `#0D4448` (feature banner)
- **Mint (Product & Accents):** `#8DE3BF` (icon) / `#8FE1BF` (feature banner)
- **Warm Sand & Off-White (Cards & Packaging):** `#FAF8F5` / `#F5FCF5` / `#CBA574`
- **Coral Accent (QR Node):** `#EB684A` (icon) / `#C6593B` (feature banner)

---

## 4. Verification (`sips` & file sizes)

```bash
sips -g pixelWidth -g pixelHeight app-icon-1200.png feature-image-1600x900.png
```
- `app-icon-1200.png`: `pixelWidth: 1200`, `pixelHeight: 1200`, size: 1.2 MB (< 2 MB)
- `feature-image-1600x900.png`: `pixelWidth: 1600`, `pixelHeight: 900`, size: 1.0 MB (< 2 MB)

---

## 5. Optimized Listing Assets (< 1 MB Submissions)

For upload surfaces strictly enforcing < 1 MB thresholds:
- `app-icon-1200-under1mb.png` (666 KB, 1200 × 1200 px, lossless 8-bit colormap PNG)
- `feature-image-1600x900-under1mb.png` (526 KB, 1600 × 900 px, lossless 8-bit colormap PNG)
- Brand asset `assets/brand/icon-v3-1200.png` and `assets/brand/icon-v3-1200-under1mb.png` (579 KB, 1200 × 1200 px, < 800 KB limit)
