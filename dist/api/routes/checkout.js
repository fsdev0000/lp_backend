"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkoutRouter = void 0;
const express_1 = require("express");
const stripe_1 = __importDefault(require("stripe"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
exports.checkoutRouter = (0, express_1.Router)();
// Helper to get initialized Stripe instance
function getStripeInstance() {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
        throw new Error('STRIPE_SECRET_KEY environment variable is not configured');
    }
    return new stripe_1.default(secretKey);
}
/**
 * POST /api/create-checkout
 * Creates a one-off Stripe Checkout session for Reset by Discipline.
 * Uses only server-configured Stripe Price ID.
 */
exports.checkoutRouter.post('/create-checkout', async (req, res) => {
    try {
        const priceId = process.env.STRIPE_BOOK_PRICE_ID;
        if (!priceId) {
            res.status(500).json({ error: 'STRIPE_BOOK_PRICE_ID environment variable is not configured' });
            return;
        }
        const stripe = getStripeInstance();
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/$/, '');
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            success_url: `${frontendUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontendUrl}/lionel`,
            metadata: {
                product: 'Reset by Discipline',
                author: 'Lionel Eersteling',
            },
        });
        if (!session.url) {
            res.status(500).json({ error: 'Failed to generate Stripe checkout URL' });
            return;
        }
        res.status(200).json({ url: session.url });
    }
    catch (error) {
        console.error('[Stripe] Error creating checkout session:', error?.message || error);
        res.status(500).json({ error: error?.message || 'Failed to create checkout session' });
    }
});
/**
 * GET /api/payment-status?session_id=...
 * Verifies payment directly against Stripe API without any application database.
 */
exports.checkoutRouter.get('/payment-status', async (req, res) => {
    try {
        const sessionId = req.query.session_id;
        if (!sessionId || typeof sessionId !== 'string') {
            res.status(400).json({ error: 'Missing or invalid session_id parameter' });
            return;
        }
        const expectedPriceId = process.env.STRIPE_BOOK_PRICE_ID;
        const stripe = getStripeInstance();
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['line_items'],
        });
        if (!session) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        const isPaid = session.payment_status === 'paid';
        // Verify product price if line items are available and expectedPriceId is set
        if (expectedPriceId && session.line_items?.data) {
            const containsExpectedProduct = session.line_items.data.some((item) => item.price?.id === expectedPriceId);
            if (!containsExpectedProduct && isPaid) {
                console.warn(`[Stripe] Session ${sessionId} does not contain expected price ID ${expectedPriceId}`);
                res.status(400).json({ status: 'unverified' });
                return;
            }
        }
        res.status(200).json({
            status: isPaid ? 'paid' : session.payment_status || 'pending',
        });
    }
    catch (error) {
        console.error('[Stripe] Error checking payment status:', error?.message || error);
        res.status(500).json({ error: 'Unable to verify payment status' });
    }
});
/**
 * GET /api/download?session_id=...
 * Serves the private PDF book only after verifying payment directly with Stripe.
 */
exports.checkoutRouter.get('/download', async (req, res) => {
    try {
        const sessionId = req.query.session_id;
        if (!sessionId || typeof sessionId !== 'string') {
            res.status(400).json({ error: 'Missing or invalid session_id' });
            return;
        }
        const expectedPriceId = process.env.STRIPE_BOOK_PRICE_ID;
        const stripe = getStripeInstance();
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['line_items'],
        });
        if (!session || session.payment_status !== 'paid') {
            res.status(403).json({ error: 'Payment not completed or session unauthorized' });
            return;
        }
        // Verify price if configured
        if (expectedPriceId && session.line_items?.data) {
            const containsExpectedProduct = session.line_items.data.some((item) => item.price?.id === expectedPriceId);
            if (!containsExpectedProduct) {
                res.status(403).json({ error: 'Unauthorized product in session' });
                return;
            }
        }
        // Resolve private file path
        const configuredPath = process.env.BOOK_FILE_PATH;
        const candidatePaths = [
            configuredPath,
            path_1.default.resolve(__dirname, '../../../private/reset-by-discipline.pdf'),
            path_1.default.resolve(process.cwd(), 'private/reset-by-discipline.pdf'),
        ].filter(Boolean);
        let resolvedPath = candidatePaths.find((p) => fs_1.default.existsSync(p));
        if (!resolvedPath) {
            console.error('[Stripe] Private book file not found at any configured path');
            res.status(404).json({ error: 'Book file not found on server' });
            return;
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="reset-by-discipline.pdf"');
        res.sendFile(path_1.default.resolve(resolvedPath));
    }
    catch (error) {
        console.error('[Stripe] Error serving download:', error?.message || error);
        res.status(403).json({ error: 'Payment verification failed' });
    }
});
/**
 * POST /api/stripe/webhook
 * Stateless webhook handler verifying Stripe signature.
 * Does NOT persist any database records.
 */
exports.checkoutRouter.post('/stripe/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret || !sig) {
        res.status(400).json({ error: 'Missing webhook secret or stripe-signature header' });
        return;
    }
    let event;
    try {
        const rawBody = req.rawBody || req.body;
        const stripe = getStripeInstance();
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    }
    catch (err) {
        console.error(`[Stripe Webhook] Verification failed:`, err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }
    // Handle specific event types statelessly
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log(`[Stripe Webhook] Checkout completed for session ${session.id}. Payment status: ${session.payment_status}`);
    }
    res.status(200).json({ received: true });
});
