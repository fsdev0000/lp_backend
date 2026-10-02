"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EXPIRES_IN_SECONDS = exports.UNMASKED_VIDEO_OBJECT = exports.UNMASKED_BUCKET = void 0;
exports.setMockSupabaseStorageClient = setMockSupabaseStorageClient;
exports.resetSupabaseStorageClient = resetSupabaseStorageClient;
exports.getSupabaseUrl = getSupabaseUrl;
exports.getSupabaseServiceKey = getSupabaseServiceKey;
exports.getSupabaseClient = getSupabaseClient;
exports.generateUnmaskedVideoSignedUrl = generateUnmaskedVideoSignedUrl;
const supabase_js_1 = require("@supabase/supabase-js");
const secrets_1 = require("./secrets");
exports.UNMASKED_BUCKET = 'unmasked-private';
exports.UNMASKED_VIDEO_OBJECT = 'unmasked-private.mp4';
// Effectively permanent / long-lived (10 years)
exports.DEFAULT_EXPIRES_IN_SECONDS = 315360000;
let cachedClient = null;
let mockClient = null;
function setMockSupabaseStorageClient(mock) {
    mockClient = mock;
}
function resetSupabaseStorageClient() {
    mockClient = null;
    cachedClient = null;
}
function getSupabaseUrl() {
    return (process.env.SUPABASE_URL ||
        process.env.VITE_SUPABASE_URL ||
        'https://tpyudbsbzrhhngulxyxp.supabase.co');
}
async function getSupabaseServiceKey() {
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
    if (process.env.SUPABASE_KEY) {
        return process.env.SUPABASE_KEY;
    }
    if (process.env.SUPABASE_SECRET_KEY) {
        return process.env.SUPABASE_SECRET_KEY;
    }
    if (process.env.SUPABASE_API_KEY) {
        return process.env.SUPABASE_API_KEY;
    }
    if (process.env.SUPABASE_ANON_KEY) {
        return process.env.SUPABASE_ANON_KEY;
    }
    const fromVault = (await (0, secrets_1.getSecret)('SUPABASE_SERVICE_ROLE_KEY')) ||
        (await (0, secrets_1.getSecret)('SUPABASE_KEY')) ||
        (await (0, secrets_1.getSecret)('SUPABASE_ANON_KEY')) ||
        (await (0, secrets_1.getSecret)('email_queue_service_role_key'));
    return fromVault;
}
async function getSupabaseClient() {
    if (mockClient) {
        return mockClient;
    }
    if (cachedClient) {
        return cachedClient;
    }
    const supabaseUrl = getSupabaseUrl();
    const serviceKey = await getSupabaseServiceKey();
    if (!serviceKey) {
        if (process.env.NODE_ENV === 'test') {
            return (0, supabase_js_1.createClient)(supabaseUrl, 'mock-service-key-for-test-env', {
                auth: { persistSession: false, autoRefreshToken: false },
            });
        }
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing in lp_backend/.env. Please add SUPABASE_SERVICE_ROLE_KEY="eyJ..." from your Supabase Dashboard (Settings > API > service_role).');
    }
    cachedClient = (0, supabase_js_1.createClient)(supabaseUrl, serviceKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    });
    return cachedClient;
}
/**
 * Generates a secure signed URL for the private unmasked-private.mp4 video file.
 * Returns a long-lived signed URL so frontend can simply call the API and play the video.
 */
async function generateUnmaskedVideoSignedUrl(expiresInSeconds = exports.DEFAULT_EXPIRES_IN_SECONDS) {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.storage
        .from(exports.UNMASKED_BUCKET)
        .createSignedUrl(exports.UNMASKED_VIDEO_OBJECT, expiresInSeconds);
    if (error) {
        const errorMsg = error.message || String(error);
        console.error('[SupabaseStorage] Signed URL generation error:', errorMsg);
        if (errorMsg.toLowerCase().includes('not found') ||
            error.statusCode === '404' ||
            error.status === 404) {
            const notFoundErr = new Error('The requested video file does not exist in storage.');
            notFoundErr.code = 'VIDEO_NOT_FOUND';
            notFoundErr.status = 404;
            throw notFoundErr;
        }
        const storageErr = new Error('Failed to generate signed video URL.');
        storageErr.code = 'STORAGE_ERROR';
        storageErr.status = 502;
        throw storageErr;
    }
    if (!data?.signedUrl) {
        const emptyErr = new Error('Storage service returned an empty URL response.');
        emptyErr.code = 'STORAGE_EMPTY_URL';
        emptyErr.status = 502;
        throw emptyErr;
    }
    return {
        videoUrl: data.signedUrl,
    };
}
