import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateQrSvg, renderHandoutHtml, escapeHtml } from '../app/lib/protocols/handout.js';

describe('Print Handout & QR Generator (app/lib/protocols/handout.js)', () => {
  describe('generateQrSvg', () => {
    it('generates a valid SVG markup string for a share URL', () => {
      const url = 'https://store.example.com/apps/protocols/tok_Abc123XyZ4567890';
      const svg = generateQrSvg(url);

      assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
      assert.ok(svg.includes('viewBox='));
      assert.ok(svg.includes('width="200"'));
      assert.ok(svg.includes('height="200"'));
      assert.ok(svg.includes('<path d="M'));
      assert.ok(svg.endsWith('</svg>'));
    });

    it('honors custom size parameter', () => {
      const svg = generateQrSvg('https://example.com', { size: 350 });
      assert.ok(svg.includes('width="350"'));
      assert.ok(svg.includes('height="350"'));
    });

    it('rejects invalid or empty text', () => {
      assert.throws(() => generateQrSvg(''), /non-empty string/);
      assert.throws(() => generateQrSvg('   '), /non-empty string/);
      assert.throws(() => generateQrSvg(null), /non-empty string/);
    });
  });

  describe('escapeHtml', () => {
    it('correctly escapes special characters to prevent XSS', () => {
      const unescaped = '<script>alert("XSS & Bad")</script>\'test\'';
      const escaped = escapeHtml(unescaped);
      assert.equal(
        escaped,
        '&lt;script&gt;alert(&quot;XSS &amp; Bad&quot;)&lt;/script&gt;&#039;test&#039;'
      );
    });

    it('handles null and undefined safely', () => {
      assert.equal(escapeHtml(null), '');
      assert.equal(escapeHtml(undefined), '');
    });
  });

  describe('renderHandoutHtml', () => {
    const mockProtocol = {
      name: 'Gut Health Reset Regimen',
      introNote: 'Follow this daily schedule for 30 consecutive days.',
      displayName: 'Integrative Wellness Clinic',
      lines: [
        {
          title: 'Spore-Based Probiotics 50B',
          quantity: 1,
          usageNote: '1 capsule morning with breakfast'
        },
        {
          title: 'L-Glutamine Powder 500g',
          quantity: 2,
          usageNote: '5g mixed in water twice daily between meals'
        }
      ]
    };

    it('renders a complete, print-ready HTML handout', () => {
      const shareUrl = 'https://my-brand.myshopify.com/apps/protocols/ghreset2026';
      const html = renderHandoutHtml({
        protocol: mockProtocol,
        practiceName: 'Elite Functional Health',
        shareUrl
      });

      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('<html lang="en">'));
      assert.ok(html.includes('@media print'));
      assert.ok(html.includes('Elite Functional Health'));
      assert.ok(html.includes('Gut Health Reset Regimen'));
      assert.ok(html.includes('Follow this daily schedule for 30 consecutive days.'));
      assert.ok(html.includes('Spore-Based Probiotics 50B'));
      assert.ok(html.includes('1 capsule morning with breakfast'));
      assert.ok(html.includes('L-Glutamine Powder 500g'));
      assert.ok(html.includes('href=""') === false); // No broken hrefs
      assert.ok(html.includes(shareUrl));
      assert.ok(html.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
    });

    it('renders on-screen Print Handout button, handoutText instructions, and footer disclaimer', () => {
      const shareUrl = 'https://my-brand.myshopify.com/apps/protocols/ghreset2026';
      const html = renderHandoutHtml({
        protocol: mockProtocol,
        practiceName: 'Elite Functional Health',
        shareUrl,
        handoutText: 'Please keep this sheet on your refrigerator.',
        footerDisclaimer: 'Custom practitioner guidelines only.'
      });

      assert.ok(!html.includes('onclick='), 'Print button must have no inline onclick handler');
      assert.ok(html.includes('<button type="button" class="print-btn no-print">Print Handout</button>'));
      const printCallSites = html.match(/window\.print\s*\(/g) || [];
      assert.equal(printCallSites.length, 1, 'Must contain exactly one window.print( call site');
      assert.ok(html.includes('no-print'), 'Must have .no-print utility class');
      assert.ok(html.includes('Please keep this sheet on your refrigerator.'), 'Must render handoutText');
      assert.ok(html.includes('Custom practitioner guidelines only.'), 'Must render footerDisclaimer');
      assert.ok(html.includes('<svg xmlns="http://www.w3.org/2000/svg"'), 'Must render inline SVG QR');
    });

    it('ensures Print Handout button has no inline onclick, exactly one window.print( call site, and output contains no "{{" or "{%" anywhere', () => {
      const shareUrl = 'https://my-brand.myshopify.com/apps/protocols/ghreset2026';
      const html = renderHandoutHtml({
        protocol: mockProtocol,
        practiceName: 'Elite Functional Health',
        shareUrl,
        handoutText: 'Please keep this sheet on your refrigerator.',
        footerDisclaimer: 'Custom practitioner guidelines only.'
      });

      assert.ok(!html.includes('onclick='), 'Rendered Print button must have no inline onclick attribute');
      assert.ok(html.includes('<button type="button" class="print-btn no-print">Print Handout</button>'));

      const printMatches = html.match(/window\.print\s*\(/g) || [];
      assert.equal(printMatches.length, 1, 'Output must contain exactly one window.print( call site');

      // Zero unescaped Liquid delimiters {{ or {% anywhere in entire document (including inside script)
      assert.ok(!html.includes('{{'), 'Document must contain no {{ anywhere');
      assert.ok(!html.includes('}}'), 'Document must contain no }} anywhere');
      assert.ok(!html.includes('{%'), 'Document must contain no {% anywhere');
      assert.ok(!html.includes('%}'), 'Document must contain no %} anywhere');
    });

    it('escapes untrusted content in protocol and practice name', () => {
      const maliciousProtocol = {
        name: 'Protocol <img src=x onerror=alert(1)>',
        introNote: 'Intro <b>bold</b> & "quotes"',
        lines: [
          {
            title: '<script>evil()</script>',
            quantity: 1,
            usageNote: 'note & <style>'
          }
        ]
      };

      const html = renderHandoutHtml({
        protocol: maliciousProtocol,
        practiceName: 'Clinic <marquee>Danger</marquee>',
        shareUrl: 'https://example.com'
      });

      assert.ok(!html.includes('<img src=x'));
      assert.ok(!html.includes('<script>evil()</script>'));
      assert.ok(!html.includes('<marquee>'));
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
      assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
    });

    it('strictly neutralizes Liquid delimiters {{, }}, {% and %} in every dynamic field (Blocker 1 & 2)', () => {
      const liquidInjectionProtocol = {
        name: 'Protocol {{ shop.name }} {% assign x = 1 %}',
        introNote: 'Intro {{ customer.email }} {% for i in (1..3) %}',
        lines: [
          {
            title: 'Line Title {{ shop.email }}',
            variantTitle: 'Variant {% if true %}',
            quantity: 2,
            usageNote: 'Usage {% assign p = 2 %} {{ shop.currency }}'
          }
        ]
      };

      const html = renderHandoutHtml({
        protocol: liquidInjectionProtocol,
        practiceName: 'Clinic {{ shop.domain }} {% endraw %}',
        shareUrl: 'https://example.com/apps/protocols/tok?q={{shop.id}}&tag={%print%}',
        handoutText: 'Handout note {{ shop.name }} {% assign a = 1 %}',
        footerDisclaimer: 'Disclaimer {{ customer.id }} {% comment %}'
      });

      // Blocker 2: starts with <!DOCTYPE html>
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));

      // Blocker 1: Strip <style> block and assert zero unescaped Liquid tags
      const bodyWithoutStyle = html.replace(/<style[\s\S]*?<\/style>/gi, '');
      assert.ok(!bodyWithoutStyle.includes('{{'), 'Handout must contain zero {{ outside style block');
      assert.ok(!bodyWithoutStyle.includes('}}'), 'Handout must contain zero }} outside style block');
      assert.ok(!bodyWithoutStyle.includes('{%'), 'Handout must contain zero {% outside style block');
      assert.ok(!bodyWithoutStyle.includes('%}'), 'Handout must contain zero %} outside style block');

      // Assert zero unescaped Liquid delimiters in the entire document (including inside script)
      assert.ok(!html.includes('{{'), 'Handout must contain zero {{ anywhere including inside script');
      assert.ok(!html.includes('{%'), 'Handout must contain zero {% anywhere including inside script');

      // Assert literal characters appear as escaped entities
      assert.ok(html.includes('&#123;&#123; shop.name &#125;&#125;'));
      assert.ok(html.includes('&#123;&#37; assign x = 1 &#37;&#125;'));
      assert.ok(html.includes('&#123;&#123; customer.email &#125;&#125;'));
      assert.ok(html.includes('&#123;&#37; for i in (1..3) &#37;&#125;'));
      assert.ok(html.includes('&#123;&#123; shop.email &#125;&#125;'));
      assert.ok(html.includes('&#123;&#37; assign p = 2 &#37;&#125;'));
      assert.ok(html.includes('&#123;&#123; shop.domain &#125;&#125;'));
      assert.ok(html.includes('&#123;&#37; endraw &#37;&#125;'));
      assert.ok(html.includes('&#123;&#123;shop.id&#125;&#125;'));
      assert.ok(html.includes('&#123;&#37;print&#37;&#125;'));
      assert.ok(html.includes('&#123;&#123; customer.id &#125;&#125;'));
    });

    it('falls back to "Unavailable product" instead of "Item 1" for genuinely unresolvable lines', () => {
      const unresolvableProto = {
        name: 'Mystery Regimen',
        lines: [
          {
            quantity: 1,
            usageNote: 'Take once daily'
          }
        ]
      };

      const html = renderHandoutHtml({
        protocol: unresolvableProto,
        practiceName: 'Wellness Center',
        shareUrl: 'https://example.com/apps/protocols/tok_test'
      });

      assert.ok(!html.includes('Item 1'), 'Must not render "Item 1" fallback');
      assert.ok(html.includes('Unavailable product'), 'Must render "Unavailable product" fallback');
      assert.ok(html.includes('line-row-unavailable'), 'Must apply line-row-unavailable class');
      assert.ok(html.includes('handout-badge-unavailable'), 'Must render unavailable badge');
    });

    it('renders "Loading product..." with data attributes and hydration script when productHandle is present', () => {
      const hydrationProto = {
        name: 'Hydration Regimen',
        lines: [
          {
            variantGid: 'gid://shopify/ProductVariant/777888',
            productHandle: 'daily-vitamin-d3',
            quantity: 2,
            usageNote: '2 drops morning'
          }
        ]
      };

      const html = renderHandoutHtml({
        protocol: hydrationProto,
        practiceName: 'Wellness Center',
        shareUrl: 'https://example.com/apps/protocols/tok_test'
      });

      assert.ok(!html.includes('Item 1'), 'Must not render "Item 1"');
      assert.ok(html.includes('Loading product...'), 'Must render "Loading product..." initial placeholder');
      assert.ok(html.includes('data-product-handle="daily-vitamin-d3"'), 'Must include data-product-handle');
      assert.ok(html.includes('data-variant-id="777888"'), 'Must include normalized data-variant-id');
      assert.ok(html.includes('data-variant-gid="gid://shopify/ProductVariant/777888"'), 'Must include data-variant-gid');
      assert.ok(html.includes('/products/'), 'Must include client-side hydration script');
      assert.ok(html.includes('.line-row[data-product-handle]'), 'Script must target data-product-handle rows');
    });

    it('renders out-of-stock badge and line-row-unavailable when available is false', () => {
      const outOfStockProto = {
        name: 'Stack with OOS item',
        lines: [
          {
            title: 'Organic Zinc Drops',
            quantity: 1,
            available: false
          }
        ]
      };

      const html = renderHandoutHtml({
        protocol: outOfStockProto,
        practiceName: 'Wellness Center',
        shareUrl: 'https://example.com/apps/protocols/tok_test'
      });

      assert.ok(html.includes('Organic Zinc Drops'));
      assert.ok(html.includes('line-row-unavailable'));
      assert.ok(html.includes('Out of stock'));
      assert.ok(html.includes('handout-badge-unavailable'));
    });

    it('throws if protocol is missing', () => {
      assert.throws(() => renderHandoutHtml({ protocol: null }), /Protocol object is required/);
    });
  });
});
