import fs from 'fs';
import nodemailer from 'nodemailer';
import { promisify } from 'util';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function sendEmail(email: any, html: any, code: any) {
    const readFile = promisify(fs.readFile);
    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: Number(process.env.EMAIL_PORT),
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        pool: true, // use pooled connection
        maxConnections: 1, // set limit to 1 connection only
        maxMessages: 100, // send 3 emails per second
        rateDelta: 20000,
        rateLimit: 5000,
    });

    try {
        const htmlContent = await readFile(html, "utf8");

        const mailOptions = {
            from: process.env.EMAIL_FROM,
            to: email,
            subject: "Email Verification",
            html: htmlContent.replace("@@code", code),
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Email enviado: ' + info.response);
        return true; // Retorna true si se envió el correo correctamente
    } catch (error) {
        console.log(error);
        return false; // Retorna false si hubo un error al enviar el correo
    }
}

export default sendEmail;
