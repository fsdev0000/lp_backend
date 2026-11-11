import tls from 'tls';

export interface SmtpEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
}

/**
 * Robust zero-dependency SMTP client using Node.js built-in TLS.
 * Automatically dispatches HTML emails via Google Workspace / SMTP.
 */
export async function sendSmtpEmail(options: SmtpEmailOptions): Promise<boolean> {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 465;
  const user = process.env.SMTP_USER || 'info@leadersperformance.ae';
  const pass = (process.env.SMTP_PASS || 'mldbajujwjonobgc').replace(/\s+/g, '');
  const from = options.from || process.env.SMTP_FROM || 'Leaders Performance Content Ops <info@leadersperformance.ae>';

  const recipients = Array.isArray(options.to)
    ? options.to
    : options.to.split(',').map((e) => e.trim()).filter(Boolean);

  if (recipients.length === 0) {
    console.warn('[SmtpDispatcher] No valid recipients provided.');
    return false;
  }

  return new Promise((resolve) => {
    try {
      const client = tls.connect(port, host, {}, () => {
        // Connected to TLS port
      });

      let step = 0;
      let rcptIndex = 0;

      client.on('data', (data) => {
        const msg = data.toString();

        if (step === 0 && msg.startsWith('220')) {
          step = 1;
          client.write(`EHLO leadersperformance.ae\r\n`);
        } else if (step === 1 && msg.startsWith('250')) {
          step = 2;
          client.write(`AUTH LOGIN\r\n`);
        } else if (step === 2 && msg.startsWith('334')) {
          step = 3;
          client.write(Buffer.from(user).toString('base64') + '\r\n');
        } else if (step === 3 && msg.startsWith('334')) {
          step = 4;
          client.write(Buffer.from(pass).toString('base64') + '\r\n');
        } else if (step === 4 && msg.startsWith('235')) {
          // Authentication successful, start mail transaction
          step = 5;
          client.write(`MAIL FROM:<${user}>\r\n`);
        } else if (step === 5 && msg.startsWith('250')) {
          // Add first recipient
          step = 6;
          client.write(`RCPT TO:<${recipients[rcptIndex]}>\r\n`);
        } else if (step === 6 && msg.startsWith('250')) {
          rcptIndex++;
          if (rcptIndex < recipients.length) {
            client.write(`RCPT TO:<${recipients[rcptIndex]}>\r\n`);
          } else {
            step = 7;
            client.write(`DATA\r\n`);
          }
        } else if (step === 7 && msg.startsWith('354')) {
          step = 8;
          const headers = [
            `From: ${from}`,
            `To: ${recipients.join(', ')}`,
            `Subject: ${options.subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/html; charset=UTF-8`,
            ``,
            options.html,
            `.`,
            ``,
          ].join('\r\n');
          client.write(headers);
        } else if (step === 8 && msg.startsWith('250')) {
          console.log(`[SmtpDispatcher] Email delivered successfully to: ${recipients.join(', ')}`);
          client.write(`QUIT\r\n`);
          resolve(true);
        } else if (msg.startsWith('5') || msg.startsWith('4')) {
          console.error(`[SmtpDispatcher] SMTP error at step ${step}:`, msg.trim());
          client.destroy();
          resolve(false);
        }
      });

      client.on('error', (err) => {
        console.error(`[SmtpDispatcher] Connection error:`, err.message);
        resolve(false);
      });

      // 15 second safety timeout
      setTimeout(() => {
        if (!client.destroyed) {
          client.destroy();
          resolve(false);
        }
      }, 15000);
    } catch (err: any) {
      console.error(`[SmtpDispatcher] Unexpected error:`, err?.message);
      resolve(false);
    }
  });
}
