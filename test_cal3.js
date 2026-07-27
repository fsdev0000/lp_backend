const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  const q = await prisma.$queryRawUnsafe('SELECT name, decrypted_secret FROM vault.decrypted_secrets');
  const secrets = {};
  q.forEach(r => secrets[r.name] = r.decrypted_secret);

  const res = await fetch('https://services.leadconnectorhq.com/calendars/?locationId=' + secrets.GHL_LOCATION_ID, {
    headers: {
      Authorization: 'Bearer ' + secrets.GHL_API_KEY,
      Version: '2021-07-28'
    }
  });
  console.log(await res.json());
  await prisma.$disconnect();
}
test();
