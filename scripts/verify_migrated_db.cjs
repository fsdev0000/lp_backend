const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const subscribers = await prisma.newsletterSubscriber.findMany();
  console.log('Migrated Subscribers Count:', subscribers.length);
  console.log('Sample Subscriber:', subscribers[0]);

  const campaigns = await prisma.newsletterCampaign.findMany();
  console.log('Campaigns Count:', campaigns.length);

  const recipients = await prisma.newsletterCampaignRecipient.findMany();
  console.log('Recipients Count:', recipients.length);
}

main().catch(console.error).finally(() => prisma.$disconnect());
