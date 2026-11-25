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

async function uploadAndAttach() {
  const imagePath = path.resolve(__dirname, 'reset-by-discipline-audiobook.jpg');
  if (!fs.existsSync(imagePath)) {
    console.error('Image file not found:', imagePath);
    return;
  }

  const { data: buckets, error: bError } = await supabase.storage.listBuckets();
  console.log('Buckets:', buckets?.map(b => `${b.name} (public: ${b.public})`), bError?.message);

  const publicBucket = buckets?.find(b => b.public)?.name || 'avatars';
  console.log('Using bucket:', publicBucket);

  const fileBuffer = fs.readFileSync(imagePath);
  const fileName = `products/reset-by-discipline-audiobook-en-${Date.now()}.jpg`;

  const { data: uploadData, error: upError } = await supabase.storage
    .from(publicBucket)
    .upload(fileName, fileBuffer, { contentType: 'image/jpeg', upsert: true });

  if (upError) {
    console.error('Upload error:', upError.message);
    return;
  }

  const { data: urlData } = supabase.storage.from(publicBucket).getPublicUrl(fileName);
  const imageUrl = urlData.publicUrl;
  console.log('Uploaded image URL:', imageUrl);

  // Update Stripe Product with the image URL
  const updatedProduct = await stripe.products.update('prod_Vh0J9AglSa0A6k', {
    images: [imageUrl],
  });

  console.log('Successfully attached image to Stripe product prod_Vh0J9AglSa0A6k!');
  console.log('Stripe product images:', updatedProduct.images);
}

uploadAndAttach().catch(err => console.error('Error:', err.message));
