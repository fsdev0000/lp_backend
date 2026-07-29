const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function test() {
  try {
    const res1 = await prisma.$queryRawUnsafe('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1 LIMIT 1', 'ELEVENLABS_API_KEY');
    const res2 = await prisma.$queryRawUnsafe('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1 LIMIT 1', 'ELEVENLABS_AGENT_ID');
    const apiKey = res1[0].decrypted_secret;
    const agentId = res2[0].decrypted_secret;
    console.log('Got credentials. Testing API...');
    const fetch = global.fetch || require('node-fetch');
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`, {
      headers: { 'xi-api-key': apiKey }
    });
    if(response.ok) console.log('SUCCESS!');
    else console.log('FAILED:', response.status, await response.text());
  } catch(e) {
    console.error(e);
  }
}
test().finally(() => prisma.$disconnect());
