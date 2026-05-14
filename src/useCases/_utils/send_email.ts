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
  [key: string]: any; // Clave y valor para cada reemplazo
}

const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const allowInsecureTls =
  String(process.env.EMAIL_ALLOW_INSECURE_TLS ?? "").trim() === "1";
const isFalsyLike = (value: any): boolean =>
  /^(0|false|no|off)$/i.test(String(value ?? "").trim());
const parsePositiveInt = (value: any, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0) return fallback;
  return normalized;
};
const EMAIL_SMTP_POOL_ENABLED = !isFalsyLike(process.env.EMAIL_SMTP_POOL_ENABLED ?? "1");
const EMAIL_SMTP_MAX_CONNECTIONS = parsePositiveInt(
  process.env.EMAIL_SMTP_MAX_CONNECTIONS,
  5
);
const EMAIL_SMTP_MAX_MESSAGES = parsePositiveInt(process.env.EMAIL_SMTP_MAX_MESSAGES, 100);
const EMAIL_CONNECTION_TIMEOUT_MS = parsePositiveInt(
  process.env.EMAIL_CONNECTION_TIMEOUT_MS,
  8000
);
const EMAIL_GREETING_TIMEOUT_MS = parsePositiveInt(
  process.env.EMAIL_GREETING_TIMEOUT_MS,
  5000
);
const EMAIL_SOCKET_TIMEOUT_MS = parsePositiveInt(process.env.EMAIL_SOCKET_TIMEOUT_MS, 10000);
const EMAIL_TEMPLATE_CACHE_ENABLED = !isFalsyLike(
  process.env.EMAIL_TEMPLATE_CACHE_ENABLED ?? "1"
);
const DEFAULT_EMAIL_FROM = String(
  process.env.EMAIL_FROM ?? "Minhoo <noreply@minhoo.app>"
).trim() || "Minhoo <noreply@minhoo.app>";
const templateCache = new Map<string, string>();
const readFile = promisify(fs.readFile);
let sharedTransporter: any = null;

const resolveFromAddress = (fromRaw?: string): string => {
  const from = String(fromRaw ?? "").trim();
  if (!from) return DEFAULT_EMAIL_FROM;
  // If caller sends only a display name (e.g. "Minhoo App"), force the configured sender.
  if (!from.includes("@")) return DEFAULT_EMAIL_FROM;
  return from;
};

const createTransporter = () => {
  if (allowInsecureTls) {
    console.warn(
      "EMAIL_ALLOW_INSECURE_TLS=1 activo: se deshabilita verificación TLS para SMTP."
    );
  }

  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    pool: EMAIL_SMTP_POOL_ENABLED,
    maxConnections: EMAIL_SMTP_MAX_CONNECTIONS,
    maxMessages: EMAIL_SMTP_MAX_MESSAGES,
    connectionTimeout: EMAIL_CONNECTION_TIMEOUT_MS,
    greetingTimeout: EMAIL_GREETING_TIMEOUT_MS,
    socketTimeout: EMAIL_SOCKET_TIMEOUT_MS,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: !allowInsecureTls,
    },
  } as any);
};
const getTransporter = (): any => {
  if (!sharedTransporter) {
    sharedTransporter = createTransporter();
  }
  return sharedTransporter;
};
const loadHtmlTemplate = async (htmlPath: string) => {
  if (EMAIL_TEMPLATE_CACHE_ENABLED && templateCache.has(htmlPath)) {
    return templateCache.get(htmlPath) as string;
  }
  const htmlContent = await readFile(htmlPath, "utf8");
  if (EMAIL_TEMPLATE_CACHE_ENABLED) {
    templateCache.set(htmlPath, htmlContent);
  }
  return htmlContent;
};
const applyReplacements = (template: string, replacements: Replacement[]) => {
  let htmlContent = template;
  replacements.forEach((replacement) => {
    Object.keys(replacement).forEach((key) => {
      const placeholder = `@@${key}`;
      const value = String(replacement[key] ?? "");
      htmlContent = htmlContent.replace(new RegExp(placeholder, "g"), value);
    });
  });
  return htmlContent;
};

export const sendEmail = async (params: SendEmailParams) => {
  const { subject, email, htmlPath, replacements, from } = params;

  if (!isValidEmail(email)) {
    console.warn(`Correo inválido ignorado: ${email}`);
    return false;
  }

  const transporter = getTransporter();

  try {
    const htmlTemplate = await loadHtmlTemplate(htmlPath);
    const htmlContent = applyReplacements(htmlTemplate, replacements);

    const mailOptions = {
      from: resolveFromAddress(from),
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

  const validEmails = emails.filter(isValidEmail);

  if (validEmails.length === 0) {
    console.warn("No hay correos válidos para enviar.");
    return false;
  }

  const transporter = getTransporter();

  try {
    const htmlTemplate = await loadHtmlTemplate(htmlPath);
    const htmlContent = applyReplacements(htmlTemplate, replacements);

    const mailOptions = {
      from: resolveFromAddress(from),
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
