const Stripe = require('stripe');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (!stripeKey.startsWith('sk_live_')) {
  console.error('ERROR: STRIPE_SECRET_KEY in .env is not a live key! Found:', stripeKey.substring(0, 8));
  process.exit(1);
}

const stripe = new Stripe(stripeKey);

async function main() {
  const productId = 'prod_Vh0J9AglSa0A6k';
  const oldPriceId = 'price_1UfcIVIpcuW0W6RhS0yE9MZ1';

  console.log('Creating new EUR price (€9.99) for product:', productId);

  // 1. Create new EUR price
  const newPrice = await stripe.prices.create({
    product: productId,
    unit_amount: 999, // €9.99
    currency: 'eur',
    metadata: {
      bookId: 'reset-by-discipline',
      version: 'en',
      productType: 'audiobook',
    },
  });

  console.log('New EUR Price created:', newPrice.id);

  // 2. Set as default price on product
  await stripe.products.update(productId, {
    default_price: newPrice.id,
  });
  console.log('Updated product default price to:', newPrice.id);

  // 3. Deactivate old USD price
  try {
    await stripe.prices.update(oldPriceId, { active: false });
    console.log('Deactivated old USD price:', oldPriceId);
  } catch (err) {
    console.warn('Notice deactivating old price:', err.message);
  }

  // 4. Retrieve updated product and active prices
  const product = await stripe.products.retrieve(productId);
  const prices = await stripe.prices.list({ product: productId, active: true });

  const result = {
    productId: product.id,
    name: product.name,
    description: product.description,
    prices: prices.data.map(p => ({
      priceId: p.id,
      currency: p.currency,
      amount: p.unit_amount,
      type: p.type,
      active: p.active,
    })),
  };

  console.log('\n================ UPDATED STRIPE PRODUCT ================');
  console.log(JSON.stringify(result, null, 2));
  console.log('========================================================\n');
  console.log('NEW STRIPE_AUDIOBOOK_PRICE_ID_EN=' + newPrice.id);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
