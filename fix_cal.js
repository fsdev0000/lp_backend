const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fix() {
  await prisma.$queryRawUnsafe("UPDATE vault.decrypted_secrets SET secret = 'uebxQpVIy9vX7tR5rL9E' WHERE name = 'GHL_CALENDAR_ID'");
  console.log('Fixed GHL_CALENDAR_ID in Vault!');
  await prisma.$disconnect();
}
fix();
