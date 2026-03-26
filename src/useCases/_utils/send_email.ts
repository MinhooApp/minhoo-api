import fs from "fs";
import nodemailer from "nodemailer";
import { promisify } from "util";
import "../../libs/config/bootstrap_env";

// Interfaz para definir todos los parámetros
interface SendEmailParams {
  subject: string; // Asunto del correo
  email: string; // Dirección del destinatario
  htmlPath: string; // Ruta al archivo HTML
  replacements: Replacement[]; // Lista de objetos con claves y valores para reemplazo
  from?: string; // Dirección del remitente opcional
}
interface SendManyEmailParams {
  subject: string;
  emails: string[]; // Lista de destinatarios
  htmlPath: string;
  replacements: Record<string, string>[]; // Lista de diccionarios con reemplazos
  from?: string;
}
// Interfaz para los reemplazos dinámicos
interface Replacement {
  [key: string]: string; // Clave y valor para cada reemplazo
}

const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const allowInsecureTls =
  String(process.env.EMAIL_ALLOW_INSECURE_TLS ?? "").trim() === "1";

const createTransporter = () => {
  if (allowInsecureTls) {
    console.warn(
      "EMAIL_ALLOW_INSECURE_TLS=1 activo: se deshabilita verificación TLS para SMTP."
    );
  }

  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: !allowInsecureTls,
    },
  });
};

export const sendEmail = async (params: SendEmailParams) => {
  const { subject, email, htmlPath, replacements, from } = params;
  const readFile = promisify(fs.readFile);

  if (!isValidEmail(email)) {
    console.warn(`Correo inválido ignorado: ${email}`);
    return false;
  }

  const transporter = createTransporter();

  try {
    let htmlContent = await readFile(htmlPath, "utf8");

    replacements.forEach((replacement) => {
      Object.keys(replacement).forEach((key) => {
        const placeholder = `@@${key}`;
        const value = replacement[key];
        htmlContent = htmlContent.replace(new RegExp(placeholder, "g"), value);
      });
    });

    const mailOptions = {
      from: from || "Minhoo App",
      to: email,
      subject: subject,
      html: htmlContent,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Correo enviado a: ${email}`);
    return true;
  } catch (error) {
    console.error("Error al enviar el correo:", error);
    return false;
  }
};

export const sendEmailToMany = async (params: SendManyEmailParams) => {
  const { subject, emails, htmlPath, replacements, from } = params;
  const readFile = promisify(fs.readFile);

  const validEmails = emails.filter(isValidEmail);

  if (validEmails.length === 0) {
    console.warn("No hay correos válidos para enviar.");
    return false;
  }

  const transporter = createTransporter();

  try {
    let htmlContent = await readFile(htmlPath, "utf8");

    replacements.forEach((replacement) => {
      Object.keys(replacement).forEach((key) => {
        const placeholder = `@@${key}`;
        const value = replacement[key];
        htmlContent = htmlContent.replace(new RegExp(placeholder, "g"), value);
      });
    });

    const mailOptions = {
      from: from || "Minhoo App",
      to: validEmails,
      subject: subject,
      html: htmlContent,
    };

    await transporter.sendMail(mailOptions);
    console.log("Correo enviado a múltiples destinatarios:", validEmails);
    return true;
  } catch (error) {
    console.error(
      "Error al enviar el correo a múltiples destinatarios:",
      error
    );
    return false;
  }
};
