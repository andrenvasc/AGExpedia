const nodemailer = require('nodemailer');

const EMAIL_FROM = process.env.EMAIL_FROM || 'cotacoes@gwtravel.com.br';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'atendimento@gwtravel.com.br';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '5511999999999';
const WHATSAPP_DISPLAY = process.env.WHATSAPP_DISPLAY || '(11) 99999-9999';

/**
 * Create email transporter based on environment config.
 * Supports SMTP (Nodemailer) and Resend API.
 */
function createTransporter() {
  // If using Resend
  if (process.env.RESEND_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: {
        user: 'resend',
        pass: process.env.RESEND_API_KEY,
      },
    });
  }

  // SMTP config
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send quotation email with link to report
 */
async function sendQuotationEmail({ to, nome, destino, checkIn, checkOut, adultos, reportUrl }) {
  const transporter = createTransporter();

  const checkInFormatted = formatDate(checkIn);
  const checkOutFormatted = formatDate(checkOut);

  const subject = `Sua cotação para ${destino} está pronta! ✈️`;

  const html = buildEmailHtml({
    nome,
    destino,
    checkIn: checkInFormatted,
    checkOut: checkOutFormatted,
    adultos,
    reportUrl,
  });

  const textContent = `Olá ${nome},\n\nSua cotação de hospedagem para ${destino} está pronta!\n\n📅 ${checkInFormatted} → ${checkOutFormatted}\n👥 ${adultos} adulto(s)\n\nAcesse sua cotação: ${reportUrl}\n\nEste link expira em 7 dias.\n\nGostou de alguma opção? Responda este e-mail ou fale conosco pelo WhatsApp: ${WHATSAPP_DISPLAY}\n\nGW Travel - Viagens Personalizadas\nwww.gwtravel.com.br`;

  const mailOptions = {
    from: `"GW Travel" <${EMAIL_FROM}>`,
    to,
    replyTo: EMAIL_REPLY_TO,
    subject,
    text: textContent,
    html,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`  → Email sent: ${info.messageId}`);
  return info;
}

/**
 * Build the email HTML template
 */
function buildEmailHtml({ nome, destino, checkIn, checkOut, adultos, reportUrl }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f5f5f5; font-family:'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="580" cellspacing="0" cellpadding="0" style="background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background-color:#000000; padding:24px 32px; text-align:center;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <span style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:32px; font-weight:700; color:#ffffff; letter-spacing:6px;">GW</span>
                    <br>
                    <span style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; color:#C9A86C; letter-spacing:4px; text-transform:uppercase;">Travel</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 32px;">
              <p style="font-size:18px; color:#333333; margin:0 0 16px;">
                Olá <strong>${escapeHtml(nome)}</strong>,
              </p>
              <p style="font-size:15px; color:#555555; margin:0 0 24px; line-height:1.6;">
                Sua cotação de hospedagem para <strong style="color:#000;">${escapeHtml(destino)}</strong> está pronta!
              </p>

              <!-- Trip Details -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#FAFAFA; border:1px solid #E0E0E0; border-radius:8px; margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="font-size:14px; color:#333; margin:0 0 6px;">&#128197; ${checkIn} → ${checkOut}</p>
                    <p style="font-size:14px; color:#333; margin:0;">&#128101; ${adultos} adulto${adultos > 1 ? 's' : ''}</p>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <a href="${reportUrl}" target="_blank" style="display:inline-block; padding:16px 40px; background-color:#000000; color:#C9A86C; font-family:'Helvetica Neue',Arial,sans-serif; font-size:15px; font-weight:600; text-decoration:none; border-radius:8px; letter-spacing:1px;">
                      VER MINHA COTAÇÃO
                    </a>
                  </td>
                </tr>
              </table>

              <p style="font-size:12px; color:#999999; text-align:center; margin:16px 0 0;">
                Este link expira em 7 dias.
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 32px;">
              <hr style="border:none; border-top:1px solid #E0E0E0; margin:0;">
            </td>
          </tr>

          <!-- Contact -->
          <tr>
            <td style="padding:24px 32px;">
              <p style="font-size:14px; color:#333333; margin:0 0 8px;">
                Gostou de alguma opção?
              </p>
              <p style="font-size:13px; color:#555555; margin:0 0 4px; line-height:1.5;">
                Responda este e-mail ou fale com nosso time pelo WhatsApp:
              </p>
              <p style="font-size:14px; color:#333333; margin:0; font-weight:600;">
                &#128241; ${WHATSAPP_DISPLAY}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#FAFAFA; padding:20px 32px; text-align:center; border-top:1px solid #E0E0E0;">
              <p style="font-size:13px; color:#777777; margin:0 0 4px; font-weight:500;">
                GW Travel - Viagens Personalizadas
              </p>
              <p style="font-size:11px; color:#999999; margin:0;">
                www.gwtravel.com.br
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Format ISO date to DD/MM/YYYY
 */
function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Escape HTML entities for safe embedding
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { sendQuotationEmail };
