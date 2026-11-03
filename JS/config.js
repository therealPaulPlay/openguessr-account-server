export const port = 3005;

export const trustedProxiesCount = 2; // Proxy count for extracting IP from X-Forwarded-For header (right to left)

export const officialUserId = 2;

export const corsOptions = {
    origin: [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3005",
        "https://openguessr.com",
        /\.openguessr\.com$/,
        "https://openguessr-86h.pages.dev",
        /\.openguessr-86h\.pages\.dev\/?$/,
        "https://autoguessr.com"
    ],
    allowedHeaders: [
        "Origin",
        "Content-Type",
        "Authorization",
        "Access-Control-Allow-Origin",
        "Access-Control-Allow-Credentials",
        "Accept",
        "cf-turnstile-response"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
};

export const dbConfig = {
    host: process.env.DB_HOST,
    port: 25060,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
};

export const jwtSecret = process.env.JWT_SECRET;
export const jwtResetSecret = process.env.JWT_RESET_SECRET;

export const googleOAuthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
export const googleOAuthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

export const appleConfig = {
    teamId: process.env.APPLE_TEAM_ID,
    keyId: process.env.APPLE_KEY_ID,
    privateKey: process.env.APPLE_PRIVATE_KEY,
    bundleId: "com.paulplay.openguessr",
    servicesId: "com.paulplay.openguessr.signin",
};

export const emailConfig = {
    host: process.env.EMAIL_HOST,
    port: 465,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
};

export const turnstileSecret = process.env.TURNSTILE_SECRET;

export const stripeKey = process.env.STRIPE_KEY;
export const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

export const reportSecret = process.env.REPORT_SECRET;
export const reportAppId = process.env.REPORT_APP_ID;
export const reportWebhookSecret = process.env.REPORT_WEBHOOK_SECRET;

export const s3Config = {
    accessKeyId: process.env.SPACES_ACCESS_KEY_ID,
    secretAccessKey: process.env.SPACES_SECRET_ACCESS_KEY,
    bucketName: process.env.SPACES_BUCKET_NAME
};

export const openRouterKey = process.env.OPENROUTER_API_KEY;
export const openRouterModel = process.env.OPENROUTER_MODEL;

export const y8GamesAppId = process.env.Y8_GAMES_APP_ID;
