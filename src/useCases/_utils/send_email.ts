import fs from 'fs';
import nodemailer from 'nodemailer';
const { promisify } = require("util");
async function sendEmail(email: any, html: any, body: any) {
    const readFile = promisify(fs.readFile);
    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: Number(process.env.EMAIL_PORT),
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        pool: true, // use pooled connection
        //rateLimit: true, // enable to make sure we are limiting
        maxConnections: 1, // set limit to 1 connection only
        maxMessages: 100, // send 3 emails per second
        rateDelta: 20000,
        rateLimit: 5000,
    });
    var html = await readFile(html, "utf8");

    var mailOptions = {
        from: process.env.EMAIL_FROM, // sender address
        to: email, // list of receivers
        subject: "Freegods Seasson init", // Subject line
        // plain text body
        html: html.replace("@@body", body.message), // html body
    };

    // send mail with defined transport object


    return await transporter.sendMail(mailOptions, function (error, info) {
        if (error) {
            console.log(error);
        } else {
            console.log('Email enviado: ' + info.response);
        }
    });
}


export default sendEmail;