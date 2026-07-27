const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  const q = await prisma.$queryRawUnsafe('SELECT name, decrypted_secret FROM vault.decrypted_secrets');
  const secrets = {};
  q.forEach(r => secrets[r.name] = r.decrypted_secret);
  
  console.log("Location:", secrets.GHL_LOCATION_ID);
  console.log("Calendar:", secrets.GHL_CALENDAR_ID);

  const res = await fetch('https://services.leadconnectorhq.com/calendars/' + secrets.GHL_CALENDAR_ID, {
    headers: {
      Authorization: 'Bearer ' + secrets.GHL_API_KEY,
      Version: '2021-07-28'
    }
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  await prisma.$disconnect();
}
test();
