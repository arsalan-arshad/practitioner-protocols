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

    it('throws if protocol is missing', () => {
      assert.throws(() => renderHandoutHtml({ protocol: null }), /Protocol object is required/);
    });
  });
});
