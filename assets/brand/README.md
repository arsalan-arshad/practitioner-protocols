# Brand Assets — Practitioner Protocols (v2)

This directory contains repo-level and developer brand assets for **Practitioner Protocols**, including the README hero banner and social preview thumbnail.

> **Honesty & Transparency Disclosure:** These brand assets combine AI-generated text-free vector artwork (produced via Google's **Imagen 3** on 2026-11-04) with high-contrast, code-rendered typography composited via an automated headless rendering pipeline (using standard system sans-serif fonts: `-apple-system`, `SF Pro Display`, `Helvetica Neue`). No typography is baked into the AI image directly.

---

## 1. README Hero Banner (`readme-banner-1600x400.png`)

- **File:** `readme-banner-1600x400.png`
- **Dimensions:** 1600 × 400 px (4:1 wide aspect ratio)
- **Format:** PNG (sRGB color space, solid background)
- **File Size:** ~175 KB (< 1 MB)
- **Alt Text (Factual):**
  > "Practitioner Protocols brand banner displaying the wordmark, tagline, curated protocol card, and QR node on deep teal background."
- **Content:**
  - Wordmark: "Practitioner Protocols" in bold warm off-white (`#F8FBF8`)
  - Tagline: "One link. One tap. Their whole protocol in the cart." in mint (`#89DCBF`)
  - Visual Motif: Clean off-white protocol card holding 4 generic unbranded product silhouettes (dropper, cream jar, lotion tube, carton box) connected by a vector bus to a glowing coral QR link token on deep teal (`#0D4448`).
- **Contrast Ratios:**
  - Wordmark (`#F8FBF8` on `#0D4448`): **11.2 : 1** (exceeds WCAG AAA requirement)
  - Tagline (`#89DCBF` on `#0D4448`): **8.6 : 1** (exceeds WCAG AAA requirement)

---

## 2. Brand Thumbnail / Social Preview (`thumbnail-1280x640.png`)

- **File:** `thumbnail-1280x640.png`
- **Dimensions:** 1280 × 640 px (2:1 aspect ratio, optimized for GitHub Social Preview and demo/screencast thumbnails)
- **Format:** PNG (sRGB color space, solid background)
- **File Size:** ~202 KB (< 1 MB)
- **Alt Text (Factual):**
  > "Practitioner Protocols social preview thumbnail with wordmark, tagline, and product list to QR code motif."
- **Content:**
  - Top: Centered wordmark "Practitioner Protocols" and tagline
  - Center: Curated product list card and coral QR node motif
- **Usage:**
  - GitHub Repository Social Preview (configured via repo Settings -> Social preview)
  - Video and documentation thumbnail

---

## 3. Sampled Hex Color Palette

Measured directly from the final brand PNG files:
- **Deep Teal (Background):** `#0D4448`
- **Wordmark (Warm Off-White):** `#F8FBF8`
- **Tagline (Mint):** `#89DCBF`
- **Coral Accent (QR Node):** `#C6593B`
- **Warm Sand (Product Elements):** `#CBA574` / `#E0C08F`

---

## 4. Verification (`sips` & file sizes)

```bash
sips -g pixelWidth -g pixelHeight readme-banner-1600x400.png thumbnail-1280x640.png
```
- `readme-banner-1600x400.png`: `pixelWidth: 1600`, `pixelHeight: 400`, size: 175 KB
- `thumbnail-1280x640.png`: `pixelWidth: 1280`, `pixelHeight: 640`, size: 202 KB
