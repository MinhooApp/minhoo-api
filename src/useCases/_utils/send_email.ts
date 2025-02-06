import fs from "fs";
import nodemailer from "nodemailer";
import { promisify } from "util";
import dotenv from "dotenv";

dotenv.config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Interfaz para definir todos los parámetros
interface SendEmailParams {
  subject: string; // Asunto del correo
  email: string; // Dirección del destinatario
  htmlPath: string; // Ruta al archivo HTML
  replacements: Replacement[]; // Lista de objetos con claves y valores para reemplazo
  from?: string; // Dirección del remitente opcional
}

// Interfaz para los reemplazos dinámicos
interface Replacement {
  [key: string]: string; // Clave y valor para cada reemplazo
}

async function sendEmail(params: SendEmailParams): Promise<boolean> {
  const { subject, email, htmlPath, replacements, from } = params; // Desestructuración de parámetros
  const readFile = promisify(fs.readFile);

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    from: "test@minhoo.app", // Intenta forzarlo aquí
  });

  try {
    // Leer contenido HTML desde la ruta proporcionada
    let htmlContent = await readFile(htmlPath, "utf8");

    // Realizar reemplazos dinámicos en el HTML
    replacements.forEach((replacement) => {
      Object.keys(replacement).forEach((key) => {
        const placeholder = `@@${key}`; // Define el marcador de reemplazo como @@clave
        const value = replacement[key];
        htmlContent = htmlContent.replace(new RegExp(placeholder, "g"), value);
      });
    });

    // Configuración del correo
    const mailOptions = {
      from: "test@test.com", // Usa el valor de `from` proporcionado o el de las variables de entorno
      to: email,
      subject: subject,
      html: htmlContent,
    };

    // Enviar el correo
    const info = await transporter.sendMail(mailOptions);
    console.log("Email enviado: " + info.response);
    return true; // Retorna true si se envió correctamente
  } catch (error) {
    console.error("Error al enviar el correo:", error);
    return false; // Retorna false si hubo un error
  }
}

export default sendEmail;
