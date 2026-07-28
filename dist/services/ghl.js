"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertContact = upsertContact;
exports.sendEmail = sendEmail;
exports.getFreeSlots = getFreeSlots;
exports.getMonthAvailability = getMonthAvailability;
exports.bookAppointment = bookAppointment;
exports.createOpportunity = createOpportunity;
exports.sendAssessmentEmail = sendAssessmentEmail;
exports.sendAdminBriefing = sendAdminBriefing;
const dotenv_1 = __importDefault(require("dotenv"));
const secrets_1 = require("./secrets");
dotenv_1.default.config();
const GHL_BASE = 'https://services.leadconnectorhq.com';
const PIPELINE_ID = 'qFBbAlnrhlBtkM5r9VEZ';
const STAGE_NEW_LEAD = 'acb058c4-2c8d-4c63-b9ba-b7019fb83b24';
const STAGE_CALL_BOOKED = 'a062e213-fbef-4a54-a11a-18751f0b3db3';
async function ghlHeaders() {
    const apiKey = await (0, secrets_1.getSecret)('GHL_API_KEY');
    if (!apiKey)
        throw new Error('GHL_API_KEY not configured in Vault or env');
    return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
    };
}
async function upsertContact(payload) {
    const locationId = await (0, secrets_1.getSecret)('GHL_LOCATION_ID');
    if (!locationId)
        throw new Error('GHL_LOCATION_ID not configured in Vault or env');
    const body = {
        locationId,
        email: payload.email,
        firstName: payload.firstName,
        lastName: payload.lastName,
        phone: payload.phone,
        source: payload.source || 'Leaders Performance Website',
        tags: payload.tags || ['Scan Lead'],
    };
    const headers = await ghlHeaders();
    const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errorData = await res.text();
        throw new Error(`Contact upsert failed: ${errorData}`);
    }
    const data = await res.json();
    return data.contact?.id;
}
async function sendEmail(contactId, subject, html) {
    const headers = await ghlHeaders();
    const res = await fetch(`${GHL_BASE}/conversations/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            type: 'Email',
            contactId,
            subject,
            html,
        }),
    });
    if (!res.ok) {
        const errorData = await res.text();
        console.error('Email send failed:', errorData);
        throw new Error(`Email send failed: ${errorData}`);
    }
    return await res.json();
}
async function getFreeSlots(date) {
    const calendarId = await (0, secrets_1.getSecret)('GHL_CALENDAR_ID');
    if (!calendarId)
        throw new Error('GHL_CALENDAR_ID not configured in Vault or env');
    const startMs = new Date(`${date}T00:00:00+04:00`).getTime();
    const endMs = new Date(`${date}T23:59:59+04:00`).getTime();
    const url = `${GHL_BASE}/calendars/${calendarId}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=Asia/Dubai`;
    const headers = await ghlHeaders();
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (!res.ok)
        throw new Error(`GHL API error: ${JSON.stringify(data)}`);
    const freeSlotTimes = new Set();
    if (data) {
        let slots = [];
        const dateKey = Object.keys(data).find((k) => k.includes(date));
        if (dateKey && data[dateKey]?.slots) {
            slots = data[dateKey].slots;
        }
        else if (data.slots) {
            if (Array.isArray(data.slots)) {
                slots = data.slots;
            }
            else {
                const slotDateKey = Object.keys(data.slots).find((k) => k.includes(date));
                if (slotDateKey)
                    slots = data.slots[slotDateKey];
            }
        }
        for (const slot of slots) {
            try {
                let timeStr = slot.includes('T') ? slot.split('T')[1].substring(0, 5) : slot.substring(0, 5);
                freeSlotTimes.add(timeStr);
            }
            catch (e) { }
        }
    }
    return Array.from(freeSlotTimes);
}
async function getMonthAvailability(year, month) {
    const calendarId = await (0, secrets_1.getSecret)('GHL_CALENDAR_ID');
    if (!calendarId)
        throw new Error('GHL_CALENDAR_ID not configured in Vault or env');
    // Create start and end date for the month
    const startDateStr = `${year}-${String(month).padStart(2, '0')}-01T00:00:00+04:00`;
    // Next month first day minus 1 ms
    const nextMonthDate = new Date(year, month, 1);
    const endMs = nextMonthDate.getTime() - 1;
    const startMs = new Date(startDateStr).getTime();
    const url = `${GHL_BASE}/calendars/${calendarId}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=Asia/Dubai`;
    const headers = await ghlHeaders();
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (!res.ok)
        throw new Error(`GHL API error: ${JSON.stringify(data)}`);
    const availabilityMap = {};
    if (data) {
        const slotsObj = data.slots || data;
        for (const dateKey of Object.keys(slotsObj)) {
            if (dateKey.match(/^\d{4}-\d{2}-\d{2}$/)) {
                let slots = [];
                if (Array.isArray(slotsObj[dateKey])) {
                    slots = slotsObj[dateKey];
                }
                else if (slotsObj[dateKey]?.slots) {
                    slots = slotsObj[dateKey].slots;
                }
                const freeSlotTimes = new Set();
                for (const slot of slots) {
                    try {
                        let timeStr = slot.includes('T') ? slot.split('T')[1].substring(0, 5) : slot.substring(0, 5);
                        freeSlotTimes.add(timeStr);
                    }
                    catch (e) { }
                }
                availabilityMap[dateKey] = Array.from(freeSlotTimes);
            }
        }
    }
    return availabilityMap;
}
async function bookAppointment(contactId, dateTime, title) {
    const calendarId = await (0, secrets_1.getSecret)('GHL_CALENDAR_ID');
    const locationId = await (0, secrets_1.getSecret)('GHL_LOCATION_ID');
    const startTime = `${dateTime}+04:00`;
    const startDate = new Date(startTime);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    const endTime = endDate.toISOString();
    const headers = await ghlHeaders();
    const res = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            calendarId,
            locationId,
            contactId,
            startTime,
            endTime,
            title,
            appointmentStatus: 'confirmed',
            assignedUserId: ''
        }),
    });
    const data = await res.json();
    if (!res.ok)
        throw new Error(`Appointment creation failed: ${JSON.stringify(data)}`);
    // Move to booked stage
    try {
        await fetch(`${GHL_BASE}/opportunities/`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                pipelineId: PIPELINE_ID,
                locationId,
                pipelineStageId: STAGE_CALL_BOOKED,
                contactId,
                name: title,
                status: 'open',
            }),
        });
    }
    catch (e) {
        console.error('Failed to move opportunity to booked stage:', e);
    }
    return data;
}
async function createOpportunity(contactId, title) {
    const locationId = await (0, secrets_1.getSecret)('GHL_LOCATION_ID');
    const headers = await ghlHeaders();
    try {
        await fetch(`${GHL_BASE}/opportunities/`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                pipelineId: PIPELINE_ID,
                locationId,
                pipelineStageId: STAGE_NEW_LEAD,
                contactId,
                name: title,
                status: 'open',
            }),
        });
    }
    catch (e) {
        console.error('Failed to create opportunity:', e);
    }
}
async function sendAssessmentEmail(contactId, data) {
    const subject = `Your Founder Pressure Scan Results`;
    const html = `<p>Hi ${data.firstName},</p><p>Your score is ${data.score} (${data.tier}).</p><p>Best,</p><p>Leaders Performance</p>`;
    return sendEmail(contactId, subject, html);
}
async function sendAdminBriefing(data, adminIds) {
    const subject = `New Scan: ${data.name}`;
    const html = `<p>A new scan was completed by ${data.name} (${data.company}).</p><p>Score: ${data.score} (${data.tier})</p>`;
    for (const id of adminIds) {
        if (id) {
            await sendEmail(id, subject, html).catch(e => console.error(e));
        }
    }
}
