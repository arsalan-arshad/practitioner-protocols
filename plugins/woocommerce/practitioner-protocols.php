<?php
/**
 * Plugin Name: Practitioner Protocols for WooCommerce
 * Plugin URI: https://github.com/arsalan-arshad/practitioner-protocols
 * Description: Enable certified practitioners and clinics to share 1-tap multi-item product recommendation routines with automatic aggregate monthly attribution and zero patient health data collection.
 * Version: 1.0.0
 * Author: Arsalan Arshad & Practitioner Protocols Community
 * Author URI: https://practitioner.arsalandev.studio
 * License: MIT
 * Text Domain: practitioner-protocols
 * WC requires at least: 5.0
 * WC tested up to: 9.0
 */

if (!defined('ABSPATH')) {
    exit; // Exit if accessed directly
}

/**
 * Main Practitioner Protocols WooCommerce Integration Class.
 */
class Practitioner_Protocols_WooCommerce {

    const SESSION_KEY = 'practitioner_protocol_token';
    const META_KEY    = '_protocol_token';

    public function __construct() {
        // 1. Capture token from query param when landing on site
        add_action('init', [$this, 'capture_protocol_token_from_url']);

        // 2. Attach token to WooCommerce cart item data
        add_filter('woocommerce_add_cart_item_data', [$this, 'attach_token_to_cart_item'], 10, 3);

        // 3. Persist token to order line item meta during checkout
        add_action('woocommerce_checkout_create_order_line_item', [$this, 'save_token_to_order_line_item'], 10, 4);

        // 4. Ensure meta key is hidden from default customer-facing order tables
        add_filter('woocommerce_hidden_order_itemmeta', [$this, 'hide_internal_meta_key']);
    }

    /**
     * Captures ?protocol_token=... or ?token=... from any landing URL and stores it in WC Session.
     */
    public function capture_protocol_token_from_url() {
        if (isset($_GET['protocol_token']) && !empty($_GET['protocol_token'])) {
            $token = sanitize_text_field(wp_unslash($_GET['protocol_token']));
            if (preg_match('/^[a-zA-Z0-9_\-]+$/', $token)) {
                if (function_exists('WC') && WC()->session) {
                    WC()->session->set(self::SESSION_KEY, $token);
                }
            }
        }
    }

    /**
     * Attaches protocol token to individual cart items.
     *
     * @param array $cart_item_data
     * @param int   $product_id
     * @param int   $variation_id
     * @return array
     */
    public function attach_token_to_cart_item($cart_item_data, $product_id, $variation_id) {
        $token = null;

        // Check URL direct parameter
        if (isset($_REQUEST['protocol_token']) && !empty($_REQUEST['protocol_token'])) {
            $token = sanitize_text_field(wp_unslash($_REQUEST['protocol_token']));
        } elseif (function_exists('WC') && WC()->session) {
            // Check active session
            $token = WC()->session->get(self::SESSION_KEY);
        }

        if ($token && preg_match('/^[a-zA-Z0-9_\-]+$/', $token)) {
            $cart_item_data[self::META_KEY] = $token;
        }

        return $cart_item_data;
    }

    /**
     * Saves protocol token into permanently stored order line item meta.
     *
     * @param WC_Order_Item_Product $item
     * @param string                $cart_item_key
     * @param array                 $values
     * @param WC_Order              $order
     */
    public function save_token_to_order_line_item($item, $cart_item_key, $values, $order) {
        if (!empty($values[self::META_KEY])) {
            $item->add_meta_data(self::META_KEY, $values[self::META_KEY], true);
        }
    }

    /**
     * Hides internal _protocol_token meta from public receipts & emails.
     *
     * @param array $hidden_keys
     * @return array
     */
    public function hide_internal_meta_key($hidden_keys) {
        $hidden_keys[] = self::META_KEY;
        return $hidden_keys;
    }
}

// Initialize only when WooCommerce is active
add_action('plugins_loaded', function() {
    if (class_exists('WooCommerce')) {
        new Practitioner_Protocols_WooCommerce();
    }
});
