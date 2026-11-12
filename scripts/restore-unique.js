const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
let c = fs.readFileSync(schemaPath, 'utf8');

c = c.replace(
  'platform              String    // LINKEDIN\n  accountType           String    @default("BUSINESS") @map("account_type")',
  'platform              String    @unique // LINKEDIN, LINKEDIN_PAGE\n  accountType           String    @default("BUSINESS") @map("account_type")'
);

fs.writeFileSync(schemaPath, c, 'utf8');
console.log('✅ Restored @unique on platform in schema.prisma');

