module.exports = {
    port: 3005,
    corsOptions: {
        origin: [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3005",
            "https://openguessr.com",
            /\.openguessr\.com$/,
            "https://openguessr-86h.pages.dev",
            /\.openguessr-86h\.pages\.dev\/?$/,
            "https://og-venatus-test.netlify.app"
        ],
        allowedHeaders: ['Origin', 'Content-Type', 'Authorization', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Accept', 'cf-turnstile-response'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
    },
    dbConfig: {
        host: process.env.DB_HOST,
        port: 25060,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
    },
    jwtSecret: process.env.JWT_SECRET,
    emailConfig: {
        host: process.env.EMAIL_HOST,
        port: 465,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    },
    turnstileSecret: process.env.TURNSTILE_SECRET,
    stripeKey: process.env.STRIPE_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    reportSecret: process.env.REPORT_SECRET,
    reportAppId: process.env.REPORT_APP_ID
};