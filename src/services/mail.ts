import { EmailClient } from "@azure/communication-email";
import { config } from "../config.js";
import { unavailable } from "../http/errors.js";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let client: EmailClient | undefined;

/**
 * Sends through Azure Communication Services. Without mail settings, development
 * logs that nothing was sent and returns false; production fails the request.
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const { connectionString, fromAddress } = config.mail;
  if (!connectionString || !fromAddress) {
    if (config.isProduction) throw unavailable("Email is not configured");
    console.warn(`[mail] not configured, skipped "${message.subject}"`);
    return false;
  }
  client ??= new EmailClient(connectionString);
  const poller = await client.beginSend({
    senderAddress: fromAddress,
    recipients: { to: [{ address: message.to }] },
    content: { subject: message.subject, html: message.html, plainText: message.text },
  });
  const result = await poller.pollUntilDone();
  if (result.status !== "Succeeded") throw new Error(`Email send failed: ${result.status}`);
  return true;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function inviteEmail(to: string, link: string, fullName?: string): MailMessage {
  const greeting = fullName ? `Hej ${fullName},` : "Hej,";
  const intro = "Du har blivit inbjuden. Välj ett lösenord för att aktivera ditt konto.";
  return {
    to,
    subject: "Du har blivit inbjuden",
    text: `${greeting}\n\n${intro}\n\n${link}\n\nLänken gäller i 24 timmar.`,
    html: `<p>${escapeHtml(greeting)}</p><p>${intro}</p><p><a href="${escapeHtml(link)}">Välj lösenord</a></p><p>Länken gäller i 24 timmar.</p>`,
  };
}
