const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = new Stripe(stripeKey);

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const imagePath = 'C:\\Users\\DELL\\.gemini\\antigravity-ide\\brain\\99c59295-ce04-41b5-9048-2e83cfa8c95a\\.user_uploaded\\media_1792135608458.jpg';
  console.log('Image exists:', fs.existsSync(imagePath));

  // 1. Check Supabase storage buckets
  const { data: buckets, error: bError } = await supabase.storage.listBuckets();
  console.log('Buckets:', buckets?.map(b => b.name), bError?.message);

  let imageUrl = '';
  if (buckets && buckets.length > 0) {
    const targetBucket = buckets.find(b => b.public)?.name || buckets[0].name;
    const fileBuffer = fs.readFileSync(imagePath);
    const fileName = `audiobook/reset-by-discipline-audiobook-en-${Date.now()}.jpg`;
    const { data: uploadData, error: upError } = await supabase.storage
      .from(targetBucket)
      .upload(fileName, fileBuffer, { contentType: 'image/jpeg', upsert: true });

    if (!upError) {
      const { data: publicUrlData } = supabase.storage.from(targetBucket).getPublicUrl(fileName);
      imageUrl = publicUrlData.publicUrl;
      console.log('Uploaded to Supabase Storage:', imageUrl);
    } else {
      console.warn('Supabase upload error:', upError.message);
    }
  }

  // 2. Fallback to Stripe File link if Supabase URL not available
  if (!imageUrl) {
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
      imageUrl = fileLink.url || '';
      console.log('Uploaded to Stripe FileLink:', imageUrl);
    } catch (err) {
      console.warn('Stripe file link error:', err.message);
    }
  }

  // 3. Create Stripe Product & Price
  const productName = 'Reset by Discipline — English Audiobook';
  const description =
    'R.E.S.E.T. By Discipline: 11 Steps to Become a Leader Performer — The complete English audiobook of this direct, no-excuses guide to personal transformation, leadership, and performance.';

  console.log('Creating Stripe Product with image:', imageUrl || '[none]');
  const product = await stripe.products.create({
    name: productName,
    description: description,
    images: imageUrl ? [imageUrl] : undefined,
    metadata: {
      bookId: 'reset-by-discipline',
      version: 'en',
      productType: 'audiobook',
      author: 'Lionel Eersteling',
    },
  });

  console.log('Product created:', product.id);

  // 4. Create Price
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

  console.log('Price created:', price.id);

  const result = {
    productId: product.id,
    name: product.name,
    description: product.description,
    images: product.images,
    prices: [
      {
        priceId: price.id,
        currency: price.currency,
        amount: price.unit_amount,
        type: 'one_time',
        active: price.active,
      },
    ],
  };

  console.log('\n================ FINAL RESULT JSON ================');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
