const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function test() {
  try {
    const res1 = await prisma.$queryRawUnsafe('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1 LIMIT 1', 'ELEVENLABS_API_KEY');
    const res2 = await prisma.$queryRawUnsafe('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1 LIMIT 1', 'ELEVENLABS_AGENT_ID');
    const apiKey = res1[0].decrypted_secret;
    const oldAgentId = res2[0]?.decrypted_secret;
    const branchId = 'agtbrch_7301kz5sjgcdf2gv2fq29ex281j8';
    const guessedAgentId = 'agent_7301kz5sjgcdf2gv2fq29ex281j8';
    console.log(`Previous Vault Agent ID was: ${oldAgentId}`);
    
    for (const testId of [branchId, guessedAgentId, oldAgentId]) {
      console.log(`\nTesting API for ID: ${testId}...`);
      const fetch = global.fetch || require('node-fetch');
      const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${testId}`, {
        headers: { 'xi-api-key': apiKey }
      });
      const text = await response.text();
      if(response.ok) console.log('--> SUCCESS:', text);
      else console.log('--> FAILED:', response.status, text);
    }
  } catch(e) {
    console.error(e);
  }
}
test().finally(() => prisma.$disconnect());
