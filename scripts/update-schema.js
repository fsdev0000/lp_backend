const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
let c = fs.readFileSync(schemaPath, 'utf8');

c = c.replace(
  'platform              String    @unique // LINKEDIN',
  'platform              String    // LINKEDIN\n  accountType           String    @default("BUSINESS") @map("account_type")'
);

c = c.replace(
  '@@map("social_account_connections")',
  '@@index([platform, accountType])\n  @@map("social_account_connections")'
);

c = c.replace(
  'label            String    // "LinkedIn Lionel personal"',
  'accountType      String    @default("BUSINESS") @map("account_type")\n  label            String    // "LinkedIn Lionel personal"'
);

c = c.replace(
  '@@index([platform, isActive])',
  '@@index([platform, isActive])\n  @@index([platform, accountType])'
);

c = c.replace(
  'saves       Int?',
  'saves       Int?\n  accountType String?  @default("BUSINESS") @map("account_type")'
);

fs.writeFileSync(schemaPath, c, 'utf8');
console.log('✅ schema.prisma updated with accountType fields.');

