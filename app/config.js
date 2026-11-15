// Timbila configuration. Fill in the Lemon Squeezy checkout links once the products exist.
export const CONFIG = {
  checkout: {
    plus: '', // e.g. https://timbila.lemonsqueezy.com/buy/xxxxxxxx  (Plus, $5, license keys on)
    pro: '',  // e.g. https://timbila.lemonsqueezy.com/buy/yyyyyyyy  (Pro, $9, license keys on)
  },
  // Optional: lock activation to your store / products. Leave empty to accept any key from the
  // license API and read the plan from the product or variant name ("Plus" or "Pro").
  storeId: null,
  products: {}, // { [productId or variantId]: 'plus' | 'pro' }
  // While no checkout link is configured, these keys unlock the plans for testing.
  demoKeys: { 'TIMBILA-PLUS-DEMO': 'plus', 'TIMBILA-PRO-DEMO': 'pro' },
};
