import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { encryptToken, decryptToken } from '../modules/automation/crypto/tokenCrypto';

const prisma = new PrismaClient();

export async function migrateEncryptSocialTokens(): Promise<{
  connectionsEncrypted: number;
  connectionsSkipped: number;
  accountsEncrypted: number;
  accountsSkipped: number;
}> {
  const encKey = (process.env.TOKEN_ENCRYPTION_KEY || '').trim();
  if (!encKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is required to run token encryption migration');
  }

  console.log('[Migration] Starting OAuth token encryption migration...');

  // 1. Migrate SocialAccountConnection
  const connections = await prisma.socialAccountConnection.findMany();
  console.log(`[Migration] Found ${connections.length} SocialAccountConnection record(s)`);

  let connectionsEncrypted = 0;
  let connectionsSkipped = 0;

  for (const conn of connections) {
    let needsUpdate = false;
    let newAccessToken = conn.accessToken;
    let newRefreshToken = conn.refreshToken;

    if (conn.accessToken && !conn.accessToken.startsWith('v1:')) {
      const original = conn.accessToken;
      const encrypted = encryptToken(original);
      const testDecrypted = decryptToken(encrypted);
      if (testDecrypted !== original) {
        throw new Error(`Self-test decryption failed for SocialAccountConnection ${conn.id} accessToken`);
      }
      newAccessToken = encrypted;
      needsUpdate = true;
    }

    if (conn.refreshToken && !conn.refreshToken.startsWith('v1:')) {
      const original = conn.refreshToken;
      const encrypted = encryptToken(original);
      const testDecrypted = decryptToken(encrypted);
      if (testDecrypted !== original) {
        throw new Error(`Self-test decryption failed for SocialAccountConnection ${conn.id} refreshToken`);
      }
      newRefreshToken = encrypted;
      needsUpdate = true;
    }

    if (needsUpdate) {
      await prisma.socialAccountConnection.update({
        where: { id: conn.id },
        data: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        },
      });
      console.log(`[Migration] Encrypted tokens for connection ${conn.platform} (${conn.accountName || conn.id})`);
      connectionsEncrypted++;
    } else {
      console.log(`[Migration] Connection ${conn.platform} (${conn.accountName || conn.id}) already encrypted`);
      connectionsSkipped++;
    }
  }

  // 2. Migrate SocialAccount (crm_social_accounts)
  const accounts = await prisma.socialAccount.findMany();
  console.log(`[Migration] Found ${accounts.length} SocialAccount record(s)`);

  let accountsEncrypted = 0;
  let accountsSkipped = 0;

  for (const acc of accounts) {
    let needsUpdate = false;
    let newTokenEncrypted = acc.tokenEncrypted;
    let newRefreshEncrypted = acc.refreshEncrypted;

    if (acc.tokenEncrypted && !acc.tokenEncrypted.startsWith('v1:')) {
      const original = acc.tokenEncrypted;
      const encrypted = encryptToken(original);
      const testDecrypted = decryptToken(encrypted);
      if (testDecrypted !== original) {
        throw new Error(`Self-test decryption failed for SocialAccount ${acc.id} tokenEncrypted`);
      }
      newTokenEncrypted = encrypted;
      needsUpdate = true;
    }

    if (acc.refreshEncrypted && !acc.refreshEncrypted.startsWith('v1:')) {
      const original = acc.refreshEncrypted;
      const encrypted = encryptToken(original);
      const testDecrypted = decryptToken(encrypted);
      if (testDecrypted !== original) {
        throw new Error(`Self-test decryption failed for SocialAccount ${acc.id} refreshEncrypted`);
      }
      newRefreshEncrypted = encrypted;
      needsUpdate = true;
    }

    if (needsUpdate) {
      await prisma.socialAccount.update({
        where: { id: acc.id },
        data: {
          tokenEncrypted: newTokenEncrypted,
          refreshEncrypted: newRefreshEncrypted,
        },
      });
      console.log(`[Migration] Encrypted tokens for SocialAccount ${acc.platform} (${acc.label || acc.id})`);
      accountsEncrypted++;
    } else {
      accountsSkipped++;
    }
  }

  // 3. Verification step
  const verifyConns = await prisma.socialAccountConnection.findMany();
  for (const c of verifyConns) {
    if (c.accessToken && !c.accessToken.startsWith('v1:')) {
      throw new Error(`Verification failed: SocialAccountConnection ${c.platform} accessToken does not start with v1:`);
    }
    if (c.refreshToken && !c.refreshToken.startsWith('v1:')) {
      throw new Error(`Verification failed: SocialAccountConnection ${c.platform} refreshToken does not start with v1:`);
    }
  }

  const verifyAccs = await prisma.socialAccount.findMany();
  for (const a of verifyAccs) {
    if (a.tokenEncrypted && !a.tokenEncrypted.startsWith('v1:')) {
      throw new Error(`Verification failed: SocialAccount ${a.platform} tokenEncrypted does not start with v1:`);
    }
    if (a.refreshEncrypted && !a.refreshEncrypted.startsWith('v1:')) {
      throw new Error(`Verification failed: SocialAccount ${a.platform} refreshEncrypted does not start with v1:`);
    }
  }

  console.log('[Migration] Completed successfully. All stored OAuth tokens now start with "v1:".');
  return {
    connectionsEncrypted,
    connectionsSkipped,
    accountsEncrypted,
    accountsSkipped,
  };
}

if (require.main === module) {
  migrateEncryptSocialTokens()
    .then((summary) => {
      console.log('[Migration Summary]', summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration Error]', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
