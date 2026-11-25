const { getSupabaseClient } = require('../src/services/supabaseStorageService.ts');
require('dotenv').config({ override: true });

async function inspectStorage() {
  const supabase = await getSupabaseClient();
  const { data: buckets, error: bErr } = await supabase.storage.listBuckets();
  console.log('Buckets:', buckets, 'Error:', bErr);

  const { data: files2026, error: fErr2026 } = await supabase.storage.from('news-letter').list('2026');
  console.log('Files in 2026:', files2026, 'Error:', fErr2026);

  const { data: files10, error: fErr10 } = await supabase.storage.from('news-letter').list('2026/10');
  console.log('Files in 2026/10:', files10, 'Error:', fErr10);

  const { data: signedData, error: sErr } = await supabase.storage
    .from('news-letter')
    .createSignedUrl('2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf', 60 * 60 * 24 * 7); // 7 days

  console.log('Signed URL:', signedData?.signedUrl, 'Error:', sErr);

  const { data: publicData } = supabase.storage
    .from('news-letter')
    .getPublicUrl('2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf');

  console.log('Public URL:', publicData?.publicUrl);
}

inspectStorage().catch(console.error);
