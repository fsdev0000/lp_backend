const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  try {
    const result = await prisma.$queryRawUnsafe('SELECT name, decrypted_secret FROM vault.decrypted_secrets');
    console.log("Vault Secrets Found:", result.length);
    result.forEach(row => {
      console.log(`Found secret: ${row.name}`);
    });
  } catch(e) {
    console.log("Error accessing vault:", e.message);
  }
}
run().finally(() => prisma.$disconnect());
