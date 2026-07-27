const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  const q = await prisma.$queryRawUnsafe('SELECT name, decrypted_secret FROM vault.decrypted_secrets');
  const secrets = {};
  q.forEach(r => secrets[r.name] = r.decrypted_secret);

  const res = await fetch('https://services.leadconnectorhq.com/calendars/events/appointments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + secrets.GHL_API_KEY,
      Version: '2021-07-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      calendarId: secrets.GHL_CALENDAR_ID,
      locationId: secrets.GHL_LOCATION_ID,
      contactId: 'some-contact-id',
      startTime: '2026-08-26T14:00:00+04:00',
      endTime: '2026-08-26T15:00:00+04:00',
      title: 'Test Appointment',
      appointmentStatus: 'confirmed'
    })
  });
  console.log(await res.json());
  
  // Test without locationId
  const res2 = await fetch('https://services.leadconnectorhq.com/calendars/events/appointments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + secrets.GHL_API_KEY,
      Version: '2021-07-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      calendarId: secrets.GHL_CALENDAR_ID,
      contactId: 'some-contact-id',
      startTime: '2026-08-26T14:00:00+04:00',
      endTime: '2026-08-26T15:00:00+04:00',
      title: 'Test Appointment',
      appointmentStatus: 'confirmed'
    })
  });
  console.log("Without locationId:", await res2.json());
  
  await prisma.$disconnect();
}
test();
