import { S3Client } from '@aws-sdk/client-s3';
import { s3Config } from "./config.js";

// Spaces connection
const spacesClient = new S3Client({
    region: 'fra1',  // Required by the S3 client
    endpoint: 'https://fra1.digitaloceanspaces.com',  // Non-CDN endpoint for API interactions other than GET
    credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
    }
});

// Get file URL – direct URL for publicly readable objects
async function getPublicObjectURL(key) {
    return `https://${s3Config.bucketName}.fra1.digitaloceanspaces.com/${key}`;
  }

export {
    spacesClient,
    getPublicObjectURL
};