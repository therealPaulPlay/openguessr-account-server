const express = require('express');
const stripeRouter = express.Router();
const { standardLimiter } = require("./rateLimiters.js");
const { authenticateTokenWithId } = require("./authUtils.js");
const { getDB } = require("./dbConnection.js");
const mailTransporter = require("./mailer.js");
const { stripeKey, stripeWebhookSecret, emailConfig } = require("./config.js");

const stripe = require('stripe')(stripeKey);

// Create Checkout Session
stripeRouter.post('/create-checkout-session', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { productId, id } = req.body;

    // Fetch user details
    db.execute('SELECT supporter_level, supported_amount FROM users WHERE id = ?', [id], async (err, results) => {
        if (err) {
            console.error('Error fetching user details:', err);
            return res.status(500).json({ error: 'An error occurred while fetching user details.' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const user = results[0];
        const basePrices = [2.99, 6.99, 14.99, 24.99];

        // Check if user is trying to buy a tier they already have
        if (user.supporter_level >= productId) {
            return res.status(400).json({ error: 'You already have access to this tier or a higher one.' });
        }

        // Calculate price
        let price = basePrices[productId - 1];
        if (user.supported_amount > 0) {
            price = Math.max(price - user.supported_amount - 0.01, 0).toFixed(2);
        }

        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card', 'paypal'],
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: `OpenGuessr Supporter Tier ${productId}`,
                                images: ["https://openguessr.com/IMG/supporter_icon.png"],
                            },
                            unit_amount: Math.round(price * 100),
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                success_url: `https://openguessr.com/?payment_completed=true`,
                cancel_url: `https://openguessr.com`,
                metadata: {
                    id: id,
                    productId: productId,
                },
                automatic_tax: {
                    enabled: true,  // Enable automatic tax
                },
            });

            res.json({ sessionId: session.id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
});

// Webhook
stripeRouter.post('/webhook', standardLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
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

    if (
        event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded'
    ) {
        const session = event.data.object;
        const { metadata, amount_total, id: purchaseId } = session; // Include session ID as purchase ID
        const { email } = session.customer_details;
        const { id, productId } = metadata;

        try {
            const mailOptions = {
                from: emailConfig.auth.user,
                to: email,
                subject: 'OpenGuessr Purchase Receipt',
                text: `Hi!
    
Thank you for completing your purchase on OpenGuessr!

Purchase ID: ${purchaseId}
Amount: $${(amount_total / 100).toFixed(2)}

If you have any questions regarding the purchase, please do not hesitate to reach out through the contact form on https://paulplay.studio.
Make sure to also provide the Purchase ID. For tax information, please refer to https://paulplay.studio/imprint.

(This email was sent automatically, please do not reply directly)`
            };

            await mailTransporter.sendMail(mailOptions);
        } catch (error) {
            console.error("Error occurred when sending email after purchase:", error);
        }

        // Update user's supporter_level and supported_amount
        const updateQuery = `
        UPDATE users 
        SET supporter_level = GREATEST(supporter_level, ?),
            supported_amount = supported_amount + ?
        WHERE id = ?
        `;

        db.execute(updateQuery, [productId, amount_total / 100, id], (err, result) => {
            if (err) {
                console.error('Error updating user details:', err);
            } else {
                console.log(`Updated user ${id} to supporter level ${productId}`);
            }
        });

        // Get the current month and year
        const currentDate = new Date();
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth() + 1; // JavaScript months are 0-based, so add 1

        // Check if an entry for the current month exists in the supporter_statistics table
        const statisticQuery = `
        INSERT INTO supporter_statistics (month, year, supported_amount) 
        VALUES (?, ?, ?) 
        ON DUPLICATE KEY UPDATE supported_amount = supported_amount + ?
        `;

        const amountInDollars = amount_total / 100;

        db.execute(statisticQuery, [month, year, amountInDollars, amountInDollars], (err, result) => {
            if (err) {
                console.error('Error updating supporter statistics:', err);
            } else {
                console.log(`Updated supporter statistics for ${month}-${year}`);
            }
        });
    }

    res.sendStatus(200);
});

stripeRouter.get('/statistics/current-month', standardLimiter, async (req, res) => {
    const db = getDB();

    // Get the current month and year
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth() + 1; // JavaScript months are 0-based, so add 1

    // Query to get the supported_amount for the current month and year
    const query = `
        SELECT supported_amount
        FROM supporter_statistics
        WHERE month = ? AND year = ?
    `;

    db.execute(query, [month, year], (err, results) => {
        if (err) {
            console.error('Error fetching current month statistics:', err);
            return res.status(500).send('Internal server error');
        }

        // If no entry exists for the current month, return 0
        if (results.length === 0) {
            return res.json({ supported_amount: 0 });
        }

        // Return the supported amount for the current month
        return res.json({ supported_amount: results[0].supported_amount });
    });
});

module.exports = stripeRouter;