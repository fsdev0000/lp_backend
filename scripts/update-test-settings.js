const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  const testSettings = {
    approverEmails: ['asif@leadersperformance.ae'],
    reportCcEmails: ['asif@leadersperformance.ae'],
    editorEmails: ['sharathkiranpr@gmail.com', 'mirza@leadersperformance.ae'],
    adminEmails: ['asif@leadersperformance.ae', 'mirza@leadersperformance.ae'],
    infoEmails: ['info@leadersperformance.ae'],
    reminderIntervalHours: [24, 48],
    maxReminders: 2,
    dryRunTestingMode: true,
    testSafetyEmail: 'asif@leadersperformance.ae',
  };

  const res = await prisma.crmSetting.upsert({
    where: { key: 'notification_settings' },
    update: {
      value: testSettings,
      description: 'Testing configuration: lionel and danielle disabled, routed to asif@leadersperformance.ae',
    },
    create: {
      key: 'notification_settings',
      value: testSettings,
      description: 'Testing configuration: lionel and danielle disabled, routed to asif@leadersperformance.ae',
    },
  });

  console.log('✅ Successfully updated CRM settings in database:', JSON.stringify(res, null, 2));
}

main()
  .catch((err) => {
    console.error('❌ Failed to update CRM settings:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

