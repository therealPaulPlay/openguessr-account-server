import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import mailTransporter from "./mailer.js";
import Stripe from 'stripe';
import { stripeKey, stripeWebhookSecret, emailConfig } from "./config.js";
import { cacheResponse } from "./responseCache.js";

const stripeRouter = express.Router();

const testKey = "rk_test_51Ple5q1DTHjmMID9EMOkN5YcL81awit40q34fdsEWcdzkjO5vIfY3l89KxzzHVtIxARucrnsvaH7gYhwFHIHlKk900nYpXCPI2"; // Not a prod key, just for testing!

const stripe = new Stripe(stripeKey, { apiVersion: '2025-08-27.basil' });

// Create stripe session (helper function)
async function createStripeSession(price, userId, productId, name, imageSrc) {
    const session = await stripe.checkout.sessions.create({
        line_items: [
            {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name,
                        images: [imageSrc],
                        tax_code: 'txcd_10103000', // Digital goods/services
                    },
                    unit_amount: Math.round(price * 100),
                },
                quantity: 1,
            },
        ],
        mode: 'payment',
        success_url: `https://openguessr.com/?payment-completed=true`,
        cancel_url: `https://openguessr.com`,
        metadata: {
            id: userId,
            productId: productId,
            service: "OpenGuessr"
        },
        managed_payments: {
            enabled: true, // Enable managed payments (Stripe remits VAT for you)
        },
    });
    return session;
}

const SUPPORTER_PRICES = [3.99, 6.99, 19.99];
const TOKEN_PRICES = [1.99, 2.99, 5.99];
const TOKEN_AMOUNTS = [900, 1650, 3600];

// Create Checkout Session
stripeRouter.post('/create-checkout-session', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { productId, id } = req.body;
    try {
        // Get user details
        const [results] = await db.promise().execute('SELECT supporter_level, supported_amount, tokens FROM users WHERE id = ?', [id]);
        if (results.length === 0) return res.status(404).json({ error: 'User not found.' });
        const user = results[0];
        let price = 0;
        let name = "Default";
        let image = "";

        if (productId.includes("supporter_tier")) {
            // Supporter tiers
            image = "https://openguessr.com/img/supporter_icon.png";
            name = "OpenGuessr Supporter";

            // Check if user is trying to buy a tier they already have
            const supporterTier = Number(productId.replace("supporter_tier_", ""));
            if (user.supporter_level >= supporterTier) return res.status(400).json({ error: 'You already have access to this tier or a higher one.' });
            price = SUPPORTER_PRICES[supporterTier - 1];
            if (user.supported_amount > 0) price = Math.max(price - user.supported_amount - 0.01, 0).toFixed(2);
        } else if (productId.includes("token_tier")) {
            // Token tiers
            const tokenImages = ["https://openguessr.com/img/token_stack_small.png", "https://openguessr.com/img/token_stack_medium.png", "https://openguessr.com/img/token_stack_large.png"];
            const tokenTier = Number(productId.replace("token_tier_", ""));
            name = "OpenGuessr Tokens";
            image = tokenImages[tokenTier - 1];
            price = TOKEN_PRICES[tokenTier - 1];
        } else {
            throw new Error("Invalid productId: " + productId);
        }

        const session = await createStripeSession(price, id, productId, name, image);
        res.json({ checkoutUrl: session.url }); // Return URL and not sessionId, so that Stripe.js isn't needed on client
    } catch (error) {
        console.error("Error creating checkout session:", error);
        res.status(500).json({ error: error.message });
    }
});

// Webhook
stripeRouter.post('/webhook', standardLimiter, async (req, res) => {
    const db = getDB();
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body, // Use the raw body here (no json parsing)
            req.headers['stripe-signature'],
            stripeWebhookSecret
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object;
        const { metadata, amount_total, id: sessionId } = session; // Include session ID as purchase ID
        const { email } = session.customer_details; // Email
        const { id, productId } = metadata; // User id and product id

        if (session.metadata?.service !== "OpenGuessr") return res.sendStatus(200); // Acknowledge & ignore – Ensures that events from other services don't result in errors
        if (session.payment_status !== "paid") {
            console.log(`Skipping unpaid checkout session with payment status: ${session.payment_status}`);
            return res.sendStatus(200); // Acknoledge and skip unpaid payments
        }

        try {
            await sendPurchaseConfirmationEmail(email, sessionId, amount_total);
        } catch (error) {
            console.error("Error occurred when sending email after purchase:", error);
        }

        try {
            if (productId.includes("supporter_tier")) {
                // Supporter callback
                const supporterTier = Number(productId.replace("supporter_tier_", ""));

                // Update user's supporter_level and supported_amount
                const updateQuery = `
                UPDATE users SET supporter_level = GREATEST(supporter_level, ?),
                supported_amount = supported_amount + ?
                WHERE id = ?`;
                await db.promise().execute(updateQuery, [supporterTier, amount_total / 100, id]);

                // Get the current month and year
                const currentDate = new Date();
                const year = currentDate.getFullYear();
                const month = currentDate.getMonth() + 1; // JavaScript months are 0-based, so add 1

                // Check if an entry for the current month exists in the supporter_statistics table
                const statisticQuery = `
                INSERT INTO supporter_statistics (month, year, supported_amount) VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE supported_amount = supported_amount + ?`;

                const amountInDollars = amount_total / 100;
                await db.promise().execute(statisticQuery, [month, year, amountInDollars, amountInDollars]);

            } else if (productId.includes("token_tier")) {
                // Tokens callback
                const tokenTier = Number(productId.replace("token_tier_", ""));
                const tokenAdd = TOKEN_AMOUNTS[tokenTier - 1];
                const updateQuery = "UPDATE users SET tokens = COALESCE(tokens, 0) + ? WHERE id = ?";
                await db.promise().execute(updateQuery, [tokenAdd, id])
            }

        } catch (error) {
            console.error(`Database operation failed in stripe webhook for user ${id} and product ${productId}:`, error);
            return res.status(500).json({ error: "Internal server error." });
        }
    }

    return res.sendStatus(200);
});

// Statistics for supporter purchases
stripeRouter.get('/statistics/current-month', standardLimiter, cacheResponse("stripe-statistics"), async (req, res) => {
    const db = getDB();

    try {
        const currentDate = new Date();
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth() + 1;

        const query = `
      SELECT supported_amount
      FROM supporter_statistics
      WHERE month = ? AND year = ?
    `;

        const [results] = await db.promise().execute(query, [month, year]);

        const supportedAmount = results.length === 0
            ? 0
            : parseFloat(results[0].supported_amount.toFixed(2));

        return res.json({ supported_amount: supportedAmount });
    } catch (error) {
        console.error('Error fetching current month statistics:', error);
        return res.status(500).json({ error: "Internal server error." });
    }
});

// Send confirmation email
async function sendPurchaseConfirmationEmail(clientEmail, sessionId, amount) {
    const mailOptions = {
        from: emailConfig.auth.user,
        to: clientEmail,
        subject: 'OpenGuessr purchase',
        text: `Hi!

Thank you for completing your purchase on OpenGuessr!

Checkout session ID: ${sessionId}
Amount: $${(amount / 100).toFixed(2)}

If you have any questions regarding the purchase, please do not hesitate to reach out through the contact form on https://paulplay.studio.
Make sure to also provide the Purchase ID. For tax information, please refer to https://paulplay.studio/imprint.

(This email was sent automatically, please do not reply directly)`
    };

    await mailTransporter.sendMail(mailOptions);
}

export default stripeRouter;