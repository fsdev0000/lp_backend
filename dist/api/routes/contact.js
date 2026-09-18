"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contactRouter = void 0;
const express_1 = require("express");
const secrets_1 = require("../../services/secrets");
exports.contactRouter = (0, express_1.Router)();
async function getGHLConfig() {
    const ghlBase = process.env.GHL_BASE ||
        (await (0, secrets_1.getSecret)('GHL_BASE')) ||
        'https://services.leadconnectorhq.com';
    const ghlApiKey = process.env.GHL_API_KEY ||
        (await (0, secrets_1.getSecret)('GHL_API_KEY'));
    const ghlLocationId = process.env.GHL_LOCATION_ID ||
        (await (0, secrets_1.getSecret)('GHL_LOCATION_ID'));
    if (!ghlApiKey) {
        throw new Error('GHL_API_KEY is not configured in .env or secrets');
    }
    if (!ghlLocationId) {
        throw new Error('GHL_LOCATION_ID is not configured in .env or secrets');
    }
    return {
        ghlBase: ghlBase.replace(/\/$/, ''),
        ghlApiKey,
        ghlLocationId,
    };
}
function getGHLHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
    };
}
const NOTIFICATION_RECIPIENTS = [
    { email: 'asif@leadersperformance.ae', firstName: 'Muhammad', lastName: 'Asif' },
    { email: 'mirza@leadersperformance.ae', firstName: 'Mirza', lastName: 'Asad' },
    { email: 'info@leadersperformance.ae', firstName: 'Lionel', lastName: 'Eersteling' },
];
function normalizePayload(body) {
    let preferredMethod = body.preferred_contact_method || body.preferredContact;
    if (preferredMethod) {
        const lower = String(preferredMethod).toLowerCase().trim();
        if (lower === 'email')
            preferredMethod = 'Email';
        else if (lower === 'phone')
            preferredMethod = 'Phone';
        else if (lower === 'whatsapp')
            preferredMethod = 'WhatsApp';
        else if (lower === 'phone or whatsapp' || lower === 'phone/whatsapp')
            preferredMethod = 'Phone or WhatsApp';
    }
    return {
        first_name: (body.first_name || body.firstName || '').trim(),
        last_name: (body.last_name || body.lastName || '').trim(),
        email: (body.email || '').trim(),
        phone: body.phone ? String(body.phone).trim() : undefined,
        company: (body.company || '').trim(),
        role: (body.role || '').trim(),
        preferred_contact_method: preferredMethod,
        message: (body.message || body.preparingFor || '').trim(),
    };
}
function validatePayload(payload) {
    const nameCharRegex = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/;
    const companyCharRegex = /^[A-Za-z0-9À-ÖØ-öø-ÿ&.,'()\- ]+$/;
    const roleCharRegex = /^[A-Za-z0-9À-ÖØ-öø-ÿ&/.,'()\- ]+$/;
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    const phoneCharRegex = /^\+?[0-9\s()\-]+$/;
    const firstName = payload.first_name || '';
    if (!firstName)
        return 'Please provide your first name.';
    if (firstName.length < 2)
        return 'First name must be at least 2 characters.';
    if (firstName.length > 50)
        return 'First name cannot exceed 50 characters.';
    if (!nameCharRegex.test(firstName))
        return 'First name can only contain letters, spaces, hyphens, and apostrophes.';
    const lastName = payload.last_name || '';
    if (!lastName)
        return 'Please provide your last name.';
    if (lastName.length < 2)
        return 'Last name must be at least 2 characters.';
    if (lastName.length > 50)
        return 'Last name cannot exceed 50 characters.';
    if (!nameCharRegex.test(lastName))
        return 'Last name can only contain letters, spaces, hyphens, and apostrophes.';
    const company = payload.company || '';
    if (!company)
        return 'Please provide your company or organisation.';
    if (company.length < 2)
        return 'Company name must be at least 2 characters.';
    if (company.length > 100)
        return 'Company name cannot exceed 100 characters.';
    if (!companyCharRegex.test(company))
        return 'Company name contains invalid characters.';
    const role = payload.role || '';
    if (!role)
        return 'Please provide your role or title.';
    if (role.length < 2)
        return 'Role must be at least 2 characters.';
    if (role.length > 100)
        return 'Role cannot exceed 100 characters.';
    if (!roleCharRegex.test(role))
        return 'Role contains invalid characters.';
    const email = payload.email || '';
    if (!email)
        return 'Please provide your email address.';
    if (email.length > 254 || !emailRegex.test(email))
        return 'Please provide a valid email address (e.g. name@company.com).';
    const phone = payload.phone;
    if (phone) {
        if (phone.length < 7)
            return 'Phone number must be at least 7 digits.';
        if (phone.length > 20)
            return 'Phone number cannot exceed 20 characters.';
        if (!phoneCharRegex.test(phone))
            return 'Please provide a valid phone number (e.g. +971 50 123 4567).';
    }
    const message = payload.message || '';
    if (!message)
        return 'Please describe what you are preparing for.';
    if (message.length < 10)
        return 'Description must be at least 10 characters.';
    if (message.length > 1000)
        return 'Description cannot exceed 1,000 characters.';
    const validMethods = ['Email', 'Phone', 'WhatsApp', 'Phone or WhatsApp'];
    if (!payload.preferred_contact_method) {
        return 'Please select your preferred contact method.';
    }
    if (!validMethods.includes(payload.preferred_contact_method)) {
        return 'Please select a valid preferred contact method.';
    }
    return null;
}
async function upsertGHLContact(payload, config) {
    const locationId = config.ghlLocationId;
    const preferredMethod = payload.preferred_contact_method || 'email';
    const tags = [
        'Contact Us Form',
        'Website Lead',
        `Preferred: ${preferredMethod.toUpperCase()}`,
    ];
    const customFields = [];
    if (payload.role) {
        customFields.push({ key: 'role', field_value: payload.role });
    }
    if (payload.preferred_contact_method) {
        customFields.push({ key: 'preferred_contact_method', field_value: payload.preferred_contact_method });
    }
    if (payload.message) {
        customFields.push({ key: 'message', field_value: payload.message });
    }
    const body = {
        locationId,
        firstName: payload.first_name,
        lastName: payload.last_name,
        email: payload.email,
        phone: payload.phone || undefined,
        companyName: payload.company || undefined,
        source: 'Leaders Performance Website Contact Form',
        tags,
    };
    if (customFields.length > 0) {
        body.customFields = customFields;
    }
    console.log('[Contact Us] Upserting GHL Contact:', payload.email);
    const res = await fetch(`${config.ghlBase}/contacts/upsert`, {
        method: 'POST',
        headers: getGHLHeaders(config.ghlApiKey),
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(`GHL Contact upsert failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
    }
    const contactId = data?.contact?.id || null;
    console.log('[Contact Us] GHL Contact upserted successfully. Contact ID:', contactId);
    return contactId;
}
async function sendInternalNotificationEmail(payload, config) {
    const locationId = config.ghlLocationId;
    const headers = getGHLHeaders(config.ghlApiKey);
    const submittedAt = new Date().toUTCString();
    const html = `
    <div style="font-family: Georgia, serif, sans-serif; color: #1a1a1a; max-width: 620px; line-height: 1.6; padding: 20px;">
      <h2 style="color: #1a1a1a; border-bottom: 2px solid #C49A45; padding-bottom: 8px; margin-top: 0;">
        New Strategic Conversation Enquiry
      </h2>
      <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
        Received from Leaders Performance website on <strong>${submittedAt}</strong>
      </p>

      <table cellpadding="8" cellspacing="0" style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr style="background: #F9F7F2;">
          <td style="font-weight: bold; width: 170px; color: #8B7355; border-bottom: 1px solid #E8E2D5;">Name:</td>
          <td style="border-bottom: 1px solid #E8E2D5;"><strong>${payload.first_name} ${payload.last_name}</strong></td>
        </tr>
        <tr>
          <td style="font-weight: bold; color: #8B7355; border-bottom: 1px solid #E8E2D5;">Email:</td>
          <td style="border-bottom: 1px solid #E8E2D5;"><a href="mailto:${payload.email}" style="color: #2C4A7C; font-weight: bold;">${payload.email}</a></td>
        </tr>
        <tr style="background: #F9F7F2;">
          <td style="font-weight: bold; color: #8B7355; border-bottom: 1px solid #E8E2D5;">Phone / WhatsApp:</td>
          <td style="border-bottom: 1px solid #E8E2D5;">${payload.phone ? `<a href="tel:${payload.phone}" style="color: #2C4A7C;">${payload.phone}</a>` : 'Not provided'}</td>
        </tr>
        <tr>
          <td style="font-weight: bold; color: #8B7355; border-bottom: 1px solid #E8E2D5;">Company:</td>
          <td style="border-bottom: 1px solid #E8E2D5;">${payload.company || 'Not provided'}</td>
        </tr>
        <tr style="background: #F9F7F2;">
          <td style="font-weight: bold; color: #8B7355; border-bottom: 1px solid #E8E2D5;">Role:</td>
          <td style="border-bottom: 1px solid #E8E2D5;">${payload.role || 'Not provided'}</td>
        </tr>
        <tr>
          <td style="font-weight: bold; color: #8B7355; border-bottom: 1px solid #E8E2D5;">Preferred Contact:</td>
          <td style="border-bottom: 1px solid #E8E2D5; font-weight: bold; color: #C49A45; text-transform: uppercase;">
            ${payload.preferred_contact_method || 'Email'}
          </td>
        </tr>
      </table>

      <div style="margin-top: 24px; padding: 18px; background: #F9F7F2; border-left: 4px solid #C49A45; border-radius: 2px;">
        <h4 style="margin: 0 0 10px; color: #1a1a1a; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;">
          What are you preparing for?
        </h4>
        <p style="margin: 0; font-size: 14px; white-space: pre-wrap; color: #222;">${payload.message || 'No description provided.'}</p>
      </div>

      <div style="margin-top: 24px; text-align: center;">
        <a href="mailto:${payload.email}?subject=Re:%20Strategic%20Conversation%20Enquiry" style="display: inline-block; background: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; font-weight: 600; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase;">
          Reply Directly to ${payload.first_name} (${payload.email})
        </a>
      </div>

      <p style="margin-top: 28px; font-size: 12px; color: #888; border-top: 1px solid #eee; padding-top: 12px;">
        Internal notification &mdash; Lionel Eersteling Strategic Consultation.
      </p>
    </div>
  `;
    const subject = `[New Consultation Enquiry] ${payload.first_name} ${payload.last_name} (${payload.company || 'Individual'})`;
    for (const recipient of NOTIFICATION_RECIPIENTS) {
        try {
            const adminUpsertRes = await fetch(`${config.ghlBase}/contacts/upsert`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    locationId,
                    firstName: recipient.firstName,
                    lastName: recipient.lastName,
                    email: recipient.email,
                    tags: ['internal-notification', 'lp-staff'],
                }),
            });
            const adminData = await adminUpsertRes.json();
            const adminContactId = adminData?.contact?.id;
            if (!adminContactId) {
                console.warn('[Contact Us] Could not retrieve admin contact id for', recipient.email, adminData);
                continue;
            }
            let emailRes = await fetch(`${config.ghlBase}/conversations/messages`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    type: 'Email',
                    contactId: adminContactId,
                    subject,
                    html,
                    emailFrom: 'Lionel Eersteling <info@leadersperformance.ae>',
                }),
            });
            if (!emailRes.ok) {
                const emailErr = await emailRes.text();
                console.warn('[Contact Us] Sending via info@leadersperformance.ae failed in GHL, trying verified:', emailErr);
                // Fallback to verified sender address in GHL
                emailRes = await fetch(`${config.ghlBase}/conversations/messages`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        type: 'Email',
                        contactId: adminContactId,
                        subject,
                        html,
                        emailFrom: 'Lionel Eersteling <info@leadersperformance.ae>',
                    }),
                });
                if (!emailRes.ok) {
                    const fallbackErr = await emailRes.text();
                    console.error('[Contact Us] Failed sending email with fallback:', fallbackErr);
                    throw new Error(`Email notification failed: ${fallbackErr}`);
                }
            }
            console.log('[Contact Us] Internal email notification sent successfully via GHL to:', recipient.email);
        }
        catch (err) {
            console.error('[Contact Us] Error dispatching notification to', recipient.email, err);
            throw err;
        }
    }
}
/**
 * @openapi
 * /contact:
 *   post:
 *     summary: Submit Contact Us Form
 *     description: Validates form input, creates/updates the contact in GoHighLevel, and dispatches internal email notifications.
 *     tags:
 *       - Contact
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - first_name
 *               - last_name
 *               - company
 *               - role
 *               - email
 *               - message
 *             properties:
 *               first_name:
 *                 type: string
 *                 example: John
 *               last_name:
 *                 type: string
 *                 example: Doe
 *               company:
 *                 type: string
 *                 example: Acme Corp
 *               role:
 *                 type: string
 *                 example: Chief Executive Officer
 *               email:
 *                 type: string
 *                 example: john.doe@acme.com
 *               phone:
 *                 type: string
 *                 example: "+971 50 123 4567"
 *               preferred_contact_method:
 *                 type: string
 *                 enum: [Email, Phone, WhatsApp, Phone or WhatsApp]
 *                 example: Email
 *               message:
 *                 type: string
 *                 example: Preparing for executive scale-up and strategic transitions.
 *     responses:
 *       200:
 *         description: Contact successfully submitted and processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 contactId:
 *                   type: string
 *       400:
 *         description: Validation error
 *       500:
 *         description: Processing error
 */
async function handleContact(req, res) {
    try {
        const payload = normalizePayload(req.body);
        // Server-side validation
        const validationError = validatePayload(payload);
        if (validationError) {
            res.status(400).json({ error: validationError });
            return;
        }
        // Retrieve GoHighLevel credentials from environment / secrets
        const config = await getGHLConfig();
        // 1. Upsert contact in GoHighLevel
        const contactId = await upsertGHLContact(payload, config);
        // 2. Send internal email notification
        try {
            await sendInternalNotificationEmail(payload, config);
        }
        catch (notifErr) {
            console.warn('[Contact Us] Internal notification email error (contact was saved):', notifErr);
        }
        // Return success response
        res.status(200).json({ success: true, contactId });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Contact Us] Submission error:', message);
        res.status(500).json({ error: message || 'Failed to process contact submission' });
    }
}
// Support both /contact and /contact-us
exports.contactRouter.post('/contact', handleContact);
exports.contactRouter.post('/contact-us', handleContact);
