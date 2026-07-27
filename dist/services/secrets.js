"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSecret = getSecret;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const secretCache = new Map();
/**
 * Fetches a secret from environment variables or Supabase Vault.
 * Results from Vault are cached in memory.
 */
async function getSecret(name) {
    // 1. Check process.env first (for local overrides)
    if (process.env[name]) {
        return process.env[name];
    }
    // 2. Check memory cache
    if (secretCache.has(name)) {
        return secretCache.get(name);
    }
    // 3. Query Supabase Vault using Prisma raw query
    try {
        const result = await prisma.$queryRawUnsafe('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1 LIMIT 1', name);
        if (result && result.length > 0) {
            const secret = result[0].decrypted_secret;
            secretCache.set(name, secret);
            return secret;
        }
    }
    catch (error) {
        console.error(`Failed to fetch secret ${name} from Vault:`, error);
    }
    return undefined;
}
