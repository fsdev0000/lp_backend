const Stripe = require('stripe');
const fs = require('fs');
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
  console.log('Using Stripe Live Key:', stripeKey.substring(0, 14) + '...');

  const imagePath = path.resolve(__dirname, 'reset-by-discipline-audiobook.jpg');
  let imageUrl = undefined;

  if (fs.existsSync(imagePath)) {
    console.log('Uploading product image to Stripe Live...');
    try {
      const file = await stripe.files.create({
        file: {
          data: fs.readFileSync(imagePath),
          name: 'reset-by-discipline-audiobook.jpg',
          type: 'image/jpeg',
        },
        purpose: 'business_icon',
      });
      const fileLink = await stripe.fileLinks.create({ file: file.id });
      imageUrl = fileLink.url;
      console.log('Image uploaded successfully:', imageUrl);
    } catch (err) {
      console.warn('Image upload error (proceeding without image):', err.message);
    }
  } else {
    console.warn('Image not found at:', imagePath);
  }

  console.log('Creating Product in Stripe Production...');
  const product = await stripe.products.create({
    name: 'Reset by Discipline — English Audiobook',
    description:
      'R.E.S.E.T. By Discipline: 11 Steps to Become a Leader Performer — The complete English audiobook of this direct, no-excuses guide to personal transformation, leadership, and performance.',
    images: imageUrl ? [imageUrl] : undefined,
    metadata: {
      bookId: 'reset-by-discipline',
      version: 'en',
      productType: 'audiobook',
      author: 'Lionel Eersteling',
    },
  });

  console.log('Product created in Production! Product ID:', product.id);

  console.log('Creating Price in Stripe Production ($9.99 USD)...');
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 999, // $9.99
    currency: 'usd',
    metadata: {
      bookId: 'reset-by-discipline',
      version: 'en',
      productType: 'audiobook',
    },
  });

  console.log('Price created in Production! Price ID:', price.id);

  console.log('\n================ UPDATE YOUR .env WITH THESE ================');
  console.log(`STRIPE_AUDIOBOOK_PRODUCT_ID_EN=${product.id}`);
  console.log(`STRIPE_AUDIOBOOK_PRICE_ID_EN=${price.id}`);
  console.log('=============================================================\n');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
});
