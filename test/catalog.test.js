import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVariantQuery,
  parseCatalogNodes,
  resolveVariants,
  enrichProtocolLines,
  createFakeVariantResolver,
  formatPrice,
  buildProductSearchQuery,
  parseProductSearchNodes,
  searchCatalogProducts
} from '../app/lib/protocols/catalog.js';

describe('Catalog Resolver Layer (app/lib/protocols/catalog.js)', () => {
  const GID_1 = 'gid://shopify/ProductVariant/101';
  const GID_2 = 'gid://shopify/ProductVariant/102';
  const GID_3 = 'gid://shopify/ProductVariant/103';

  describe('buildVariantQuery', () => {
    it('constructs standard nodes query for variant IDs', () => {
      const { query } = buildVariantQuery();
      assert.ok(query.includes('query ResolveVariants($ids: [ID!]!)'));
      assert.ok(query.includes('nodes(ids: $ids)'));
      assert.ok(query.includes('... on ProductVariant'));
      assert.ok(query.includes('availableForSale'));
      assert.ok(query.includes('price'));
      assert.ok(query.includes('product'));
      // Storefront API Product has no status field; verify status is not queried
      assert.equal(query.includes('status'), false);
    });

    it('injects @inContext directive when country or language is specified', () => {
      const { query } = buildVariantQuery({ country: 'CA', language: 'FR' });
      assert.ok(query.includes('@inContext(country: $country, language: $language)'));
      assert.ok(query.includes('$country: CountryCode'));
      assert.ok(query.includes('$language: LanguageCode'));
    });
  });

  describe('parseCatalogNodes', () => {
    it('parses valid Storefront GraphQL nodes with price object', () => {
      const rawNodes = [
        {
          id: GID_1,
          title: '60 Softgels',
          availableForSale: true,
          price: { amount: '29.99', currencyCode: 'USD' },
          image: { url: 'https://cdn.shopify.com/softgels.png', altText: 'Bottle' },
          product: {
            id: 'gid://shopify/Product/1',
            title: 'Omega-3 EPA/DHA',
            handle: 'omega-3',
            status: 'ACTIVE'
          }
        }
      ];

      const map = parseCatalogNodes([GID_1], rawNodes);
      assert.equal(map.size, 1);
      const item = map.get(GID_1);

      assert.equal(item.variantGid, GID_1);
      assert.equal(item.variantId, '101');
      assert.equal(item.productTitle, 'Omega-3 EPA/DHA');
      assert.equal(item.variantTitle, '60 Softgels');
      assert.equal(item.title, 'Omega-3 EPA/DHA - 60 Softgels');
      assert.equal(item.price, '29.99');
      assert.equal(item.priceMinor, 2999);
      assert.equal(item.currency, 'USD');
      assert.equal(item.availableForSale, true);
      assert.equal(item.isDeleted, false);
      assert.equal(item.isPublished, true);
      assert.equal(item.image.url, 'https://cdn.shopify.com/softgels.png');
    });

    it('suppresses "Default Title" from display title', () => {
      const rawNodes = [
        {
          id: GID_2,
          title: 'Default Title',
          availableForSale: true,
          price: { amount: '15.00', currencyCode: 'USD' },
          product: {
            title: 'Vitamin D3 Drops',
            status: 'ACTIVE'
          }
        }
      ];

      const map = parseCatalogNodes([GID_2], rawNodes);
      const item = map.get(GID_2);
      assert.equal(item.variantTitle, null);
      assert.equal(item.title, 'Vitamin D3 Drops');
    });

    it('marks missing or null nodes as deleted/unavailable', () => {
      const rawNodes = [null]; // GID_3 was deleted from Shopify catalog
      const map = parseCatalogNodes([GID_3], rawNodes);

      assert.equal(map.size, 1);
      const item = map.get(GID_3);
      assert.equal(item.variantGid, GID_3);
      assert.equal(item.variantId, '103');
      assert.equal(item.title, 'Unavailable Product');
      assert.equal(item.availableForSale, false);
      assert.equal(item.isDeleted, true);
      assert.equal(item.isPublished, false);
      assert.equal(item.priceMinor, 0);
    });

    it('marks non-ACTIVE draft or archived products as unpublished/unavailable', () => {
      const rawNodes = [
        {
          id: GID_1,
          title: 'Default Title',
          availableForSale: true,
          price: { amount: '20.00', currencyCode: 'USD' },
          product: {
            title: 'Draft Product',
            status: 'DRAFT'
          }
        }
      ];

      const map = parseCatalogNodes([GID_1], rawNodes);
      const item = map.get(GID_1);
      assert.equal(item.isPublished, false);
      assert.equal(item.availableForSale, false);
      assert.equal(item.isDeleted, false);
    });

    it('supports 0-decimal currencies (JPY) and 3-decimal currencies (KWD)', () => {
      const rawNodes = [
        {
          id: GID_1,
          title: 'Default Title',
          availableForSale: true,
          price: { amount: '2500', currencyCode: 'JPY' },
          product: { title: 'Tea', status: 'ACTIVE' }
        },
        {
          id: GID_2,
          title: 'Default Title',
          availableForSale: true,
          price: { amount: '12.500', currencyCode: 'KWD' },
          product: { title: 'Oil', status: 'ACTIVE' }
        }
      ];

      const map = parseCatalogNodes([GID_1, GID_2], rawNodes);
      assert.equal(map.get(GID_1).priceMinor, 2500); // 0 decimals
      assert.equal(map.get(GID_2).priceMinor, 12500); // 3 decimals
    });
  });

  describe('resolveVariants with GraphQL executor', () => {
    it('executes query and returns normalized map', async () => {
      const mockExecutor = async ({ query, variables }) => {
        assert.deepEqual(variables.ids, [GID_1]);
        return {
          data: {
            nodes: [
              {
                id: GID_1,
                title: 'Default Title',
                availableForSale: true,
                price: { amount: '35.50', currencyCode: 'USD' },
                product: { title: 'Probiotics', status: 'ACTIVE' }
              }
            ]
          }
        };
      };

      const map = await resolveVariants('test.myshopify.com', [GID_1], {
        graphqlExecutor: mockExecutor
      });

      assert.equal(map.size, 1);
      assert.equal(map.get(GID_1).title, 'Probiotics');
      assert.equal(map.get(GID_1).price, '35.50');
      assert.equal(map.get(GID_1).availableForSale, true);
    });

    it('returns empty map immediately for empty variant GIDs list', async () => {
      let called = false;
      const mockExecutor = async () => {
        called = true;
      };

      const map = await resolveVariants('test.myshopify.com', [], {
        graphqlExecutor: mockExecutor
      });

      assert.equal(map.size, 0);
      assert.equal(called, false);
    });

    it('catches upstream network or GraphQL errors safely and returns unavailable records without throwing', async () => {
      const mockExecutor = async () => {
        throw new Error('Storefront API Rate Limit Exceeded');
      };

      const map = await resolveVariants('test.myshopify.com', [GID_1, GID_2], {
        graphqlExecutor: mockExecutor
      });

      assert.equal(map.size, 2);
      assert.equal(map.get(GID_1).availableForSale, false);
      assert.equal(map.get(GID_2).availableForSale, false);
      assert.equal(map.get(GID_1).title, 'Unavailable Product');
    });
  });

  describe('enrichProtocolLines', () => {
    it('merges resolved catalog metadata into protocol lines', () => {
      const lines = [
        {
          variantGid: GID_1,
          quantity: 2,
          usageNote: 'Take with breakfast',
          position: 0
        },
        {
          variantGid: GID_2,
          quantity: 1,
          usageNote: 'Take before bed',
          position: 1
        }
      ];

      const catalogMap = new Map([
        [
          GID_1,
          {
            variantGid: GID_1,
            variantId: '101',
            productTitle: 'Zinc Glycinate',
            variantTitle: null,
            title: 'Zinc Glycinate',
            price: '18.00',
            priceMinor: 1800,
            currency: 'USD',
            availableForSale: true,
            isDeleted: false,
            isPublished: true,
            image: { url: 'https://cdn.example.com/zinc.jpg', altText: 'Zinc' }
          }
        ],
        [
          GID_2,
          {
            variantGid: GID_2,
            variantId: '102',
            productTitle: 'Magnesium',
            variantTitle: 'Lavender',
            title: 'Magnesium - Lavender',
            price: '24.50',
            priceMinor: 2450,
            currency: 'USD',
            availableForSale: false, // out of stock
            isDeleted: false,
            isPublished: true,
            image: null
          }
        ]
      ]);

      const enriched = enrichProtocolLines(lines, catalogMap);
      assert.equal(enriched.length, 2);

      // Line 1 checks
      assert.equal(enriched[0].variantGid, GID_1);
      assert.equal(enriched[0].quantity, 2);
      assert.equal(enriched[0].usageNote, 'Take with breakfast');
      assert.equal(enriched[0].title, 'Zinc Glycinate');
      assert.equal(enriched[0].price, '18.00');
      assert.equal(enriched[0].available, true);
      assert.equal(enriched[0].inStock, true);
      assert.equal(enriched[0].image.url, 'https://cdn.example.com/zinc.jpg');

      // Line 2 checks (out of stock)
      assert.equal(enriched[1].title, 'Magnesium - Lavender');
      assert.equal(enriched[1].available, false);
      assert.equal(enriched[1].inStock, false);
    });

    it('filters out deleted/unpublished variants when filterUnavailable: true', () => {
      const lines = [
        { variantGid: GID_1, quantity: 1 },
        { variantGid: GID_3, quantity: 1 } // deleted
      ];

      const catalogMap = new Map([
        [
          GID_1,
          {
            variantGid: GID_1,
            variantId: '101',
            title: 'Active Product',
            price: '10.00',
            currency: 'USD',
            availableForSale: true,
            isDeleted: false,
            isPublished: true
          }
        ],
        [
          GID_3,
          {
            variantGid: GID_3,
            variantId: '103',
            title: 'Unavailable Product',
            price: '0.00',
            currency: 'USD',
            availableForSale: false,
            isDeleted: true,
            isPublished: false
          }
        ]
      ]);

      const enriched = enrichProtocolLines(lines, catalogMap, { filterUnavailable: true });
      assert.equal(enriched.length, 1);
      assert.equal(enriched[0].variantGid, GID_1);
    });
  });

  describe('createFakeVariantResolver', () => {
    it('creates deterministic in-memory resolver with fixtures', async () => {
      const fakeResolver = createFakeVariantResolver({
        [GID_1]: {
          productTitle: 'Fake Vitamin C',
          variantTitle: '1000mg',
          price: '19.99',
          currency: 'USD',
          availableForSale: true
        }
      });

      const map = await fakeResolver.resolveVariants('test.myshopify.com', [GID_1, GID_2]);
      assert.equal(map.size, 2);

      const item1 = map.get(GID_1);
      assert.equal(item1.title, 'Fake Vitamin C - 1000mg');
      assert.equal(item1.price, '19.99');
      assert.equal(item1.priceMinor, 1999);
      assert.equal(item1.availableForSale, true);

      const item2 = map.get(GID_2); // unseeded -> unavailable
      assert.equal(item2.title, 'Unavailable Product');
      assert.equal(item2.availableForSale, false);
      assert.equal(item2.isDeleted, true);
    });
  });

  describe('formatPrice', () => {
    it('formats price with currency symbol', () => {
      assert.equal(formatPrice('29.99', 'USD'), '$29.99');
      assert.equal(formatPrice('2500', 'JPY'), '¥2,500');
      assert.equal(formatPrice('15.50', 'EUR'), '€15.50');
      assert.equal(formatPrice('12.00', 'GBP'), '£12.00');
      assert.equal(formatPrice('50.00', 'AUD'), 'A$50.00');
    });
  });

  describe('Product Search Query & Parser', () => {
    it('builds product search query with parameters', () => {
      const { query } = buildProductSearchQuery();
      assert.ok(query.includes('query SearchProducts($query: String!, $first: Int!)'));
      assert.ok(query.includes('products(first: $first, query: $query)'));
      assert.ok(query.includes('variants(first: 20)'));
    });

    it('builds product search query with @inContext directive', () => {
      const { query } = buildProductSearchQuery({ country: 'CA', language: 'FR' });
      assert.ok(query.includes('@inContext(country: $country, language: $language)'));
    });

    it('parses product search nodes into clean product and variant representations', () => {
      const rawEdges = [
        {
          node: {
            id: 'gid://shopify/Product/1',
            title: 'Magnesium Glycinate',
            handle: 'magnesium-glycinate',
            featuredImage: { url: 'https://cdn.shopify.com/magnesium.png', altText: 'Magnesium' },
            variants: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/ProductVariant/201',
                    title: '120 Capsules',
                    availableForSale: true,
                    price: { amount: '34.95', currencyCode: 'USD' },
                    image: { url: 'https://cdn.shopify.com/mag-120.png', altText: '120 Caps' }
                  }
                },
                {
                  node: {
                    id: 'gid://shopify/ProductVariant/202',
                    title: 'Default Title',
                    availableForSale: false,
                    price: { amount: '19.95', currencyCode: 'USD' }
                  }
                }
              ]
            }
          }
        }
      ];

      const products = parseProductSearchNodes(rawEdges);
      assert.equal(products.length, 1);
      const prod = products[0];
      assert.equal(prod.id, 'gid://shopify/Product/1');
      assert.equal(prod.productId, '1');
      assert.equal(prod.title, 'Magnesium Glycinate');
      assert.equal(prod.handle, 'magnesium-glycinate');
      assert.equal(prod.imageUrl, 'https://cdn.shopify.com/magnesium.png');
      assert.equal(prod.variants.length, 2);

      const v1 = prod.variants[0];
      assert.equal(v1.id, 'gid://shopify/ProductVariant/201');
      assert.equal(v1.variantId, '201');
      assert.equal(v1.title, '120 Capsules');
      assert.equal(v1.displayTitle, 'Magnesium Glycinate - 120 Capsules');
      assert.equal(v1.price, '34.95');
      assert.equal(v1.priceFormatted, '$34.95');
      assert.equal(v1.availableForSale, true);
      assert.equal(v1.imageUrl, 'https://cdn.shopify.com/mag-120.png');

      const v2 = prod.variants[1];
      assert.equal(v2.title, null); // Suppresses 'Default Title'
      assert.equal(v2.displayTitle, 'Magnesium Glycinate');
      assert.equal(v2.availableForSale, false);
    });

    it('executes searchCatalogProducts using mock executor', async () => {
      const mockExecutor = async () => ({
        products: {
          edges: [
            {
              node: {
                id: 'gid://shopify/Product/10',
                title: 'Zinc Picolinate',
                variants: {
                  edges: [
                    {
                      node: {
                        id: 'gid://shopify/ProductVariant/301',
                        title: 'Default Title',
                        availableForSale: true,
                        price: { amount: '12.50', currencyCode: 'USD' }
                      }
                    }
                  ]
                }
              }
            }
          ]
        }
      });

      const results = await searchCatalogProducts('test.myshopify.com', 'Zinc', {
        graphqlExecutor: mockExecutor
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].title, 'Zinc Picolinate');
      assert.equal(results[0].variants[0].priceFormatted, '$12.50');
    });

    it('searches products with createFakeVariantResolver.searchProducts', async () => {
      const resolver = createFakeVariantResolver({}, [
        {
          id: 'gid://shopify/Product/1',
          title: 'Daily Omega 3',
          variants: [
            { id: 'gid://shopify/ProductVariant/1', displayTitle: 'Daily Omega 3 - 60ct' }
          ]
        },
        {
          id: 'gid://shopify/Product/2',
          title: 'Vitamin C Powder',
          variants: [
            { id: 'gid://shopify/ProductVariant/2', displayTitle: 'Vitamin C Powder - 250g' }
          ]
        }
      ]);

      const match = await resolver.searchProducts('test.myshopify.com', 'omega');
      assert.equal(match.length, 1);
      assert.equal(match[0].title, 'Daily Omega 3');

      const noMatch = await resolver.searchProducts('test.myshopify.com', 'nonexistent');
      assert.equal(noMatch.length, 0);

      const emptyQuery = await resolver.searchProducts('test.myshopify.com', '');
      assert.equal(emptyQuery.length, 0);
    });
  });
});
