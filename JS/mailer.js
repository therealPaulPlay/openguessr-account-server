import nodemailer from 'nodemailer';
import { emailConfig } from "./config.js";

// Email service configuration
const transporter = nodemailer.createTransport(emailConfig);

export default transporter;