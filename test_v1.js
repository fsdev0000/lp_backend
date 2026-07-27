const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  const q = await prisma.$queryRawUnsafe('SELECT name, decrypted_secret FROM vault.decrypted_secrets');
  const secrets = {};
  q.forEach(r => secrets[r.name] = r.decrypted_secret);

  const res = await fetch('https://rest.gohighlevel.com/v1/appointments/', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + secrets.GHL_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      calendarId: secrets.GHL_CALENDAR_ID,
      selectedTimezone: 'Asia/Dubai',
      selectedSlot: '2026-08-26T10:00:00+04:00',
      email: 'test@example.com'
    })
  });
  console.log(await res.json());
  await prisma.$disconnect();
}
test();
