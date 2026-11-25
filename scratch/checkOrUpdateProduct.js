const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
console.log('Using Stripe Key:', stripeKey.substring(0, 12) + '...');
const stripe = new Stripe(stripeKey);

async function check() {
  try {
    const product = await stripe.products.retrieve('prod_VRzqmjGl2mVi9v');
    console.log('Product retrieved successfully:', {
      id: product.id,
      name: product.name,
      images: product.images,
      active: product.active,
      default_price: product.default_price,
    });
  } catch (err) {
    console.error('Error retrieving product:', err.message, err.code);
  }
}

check();
