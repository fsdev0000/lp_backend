import dotenv from 'dotenv';
import { getSecret } from './secrets';
dotenv.config();

const GHL_BASE = 'https://services.leadconnectorhq.com';
const PIPELINE_ID = 'qFBbAlnrhlBtkM5r9VEZ';
const STAGE_NEW_LEAD = 'acb058c4-2c8d-4c63-b9ba-b7019fb83b24';
const STAGE_CALL_BOOKED = 'a062e213-fbef-4a54-a11a-18751f0b3db3';

async function ghlHeaders() {
  const apiKey = await getSecret('GHL_API_KEY');
  if (!apiKey) throw new Error('GHL_API_KEY not configured in Vault or env');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };
}

export async function upsertContact(payload: { email: string; firstName?: string; lastName?: string; phone?: string; source?: string; tags?: string[] }) {
  const locationId = await getSecret('GHL_LOCATION_ID');
  if (!locationId) throw new Error('GHL_LOCATION_ID not configured in Vault or env');

  const body: any = {
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
  
  const data: any = await res.json();
  return data.contact?.id;
}

export async function sendEmail(contactId: string, subject: string, html: string) {
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

export async function getCalendarInfo(): Promise<{ name: string; duration: number }> {
  const calendarId = await getSecret('GHL_CALENDAR_ID');
  if (!calendarId) throw new Error('GHL_CALENDAR_ID not configured in Vault or env');

  const headers = await ghlHeaders();
  const res = await fetch(`${GHL_BASE}/calendars/${calendarId}`, { headers });
  if (!res.ok) throw new Error(`GHL Calendar fetch failed: ${res.status}`);

  const data: any = await res.json();
  const cal = data.calendar || data;

  return {
    name: cal.name || 'Strategic Review',
    duration: cal.slotDuration || cal.appointmentPerSlot || 45,
  };
}

export async function getFreeSlots(date: string) {
  const calendarId = await getSecret('GHL_CALENDAR_ID');
  if (!calendarId) throw new Error('GHL_CALENDAR_ID not configured in Vault or env');

  const startMs = new Date(`${date}T00:00:00+04:00`).getTime();
  const endMs = new Date(`${date}T23:59:59+04:00`).getTime();

  const url = `${GHL_BASE}/calendars/${calendarId}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=Asia/Dubai`;
  
  const headers = await ghlHeaders();
  const res = await fetch(url, { headers });
  const data: any = await res.json();

  if (!res.ok) throw new Error(`GHL API error: ${JSON.stringify(data)}`);

  const freeSlotTimes = new Set<string>();
  
  if (data) {
    let slots: string[] = [];
    const dateKey = Object.keys(data).find((k: string) => k.includes(date));
    if (dateKey && data[dateKey]?.slots) {
      slots = data[dateKey].slots;
    } else if (data.slots) {
      if (Array.isArray(data.slots)) {
        slots = data.slots;
      } else {
        const slotDateKey = Object.keys(data.slots).find((k: string) => k.includes(date));
        if (slotDateKey) slots = data.slots[slotDateKey];
      }
    }

    for (const slot of slots) {
      try {
        let timeStr = slot.includes('T') ? slot.split('T')[1].substring(0, 5) : slot.substring(0, 5);
        freeSlotTimes.add(timeStr);
      } catch (e) {}
    }
  }

  return Array.from(freeSlotTimes);
}

export async function getMonthAvailability(year: number, month: number) {
  const calendarId = await getSecret('GHL_CALENDAR_ID');
  if (!calendarId) throw new Error('GHL_CALENDAR_ID not configured in Vault or env');

  // Create start and end date for the month
  const startDateStr = `${year}-${String(month).padStart(2, '0')}-01T00:00:00+04:00`;
  // Next month first day minus 1 ms
  const nextMonthDate = new Date(year, month, 1);
  const endMs = nextMonthDate.getTime() - 1;
  const startMs = new Date(startDateStr).getTime();

  const url = `${GHL_BASE}/calendars/${calendarId}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=Asia/Dubai`;
  
  const headers = await ghlHeaders();
  const res = await fetch(url, { headers });
  const data: any = await res.json();

  if (!res.ok) throw new Error(`GHL API error: ${JSON.stringify(data)}`);

  const availabilityMap: Record<string, string[]> = {};
  
  if (data) {
    const slotsObj = data.slots || data;
    for (const dateKey of Object.keys(slotsObj)) {
      if (dateKey.match(/^\d{4}-\d{2}-\d{2}$/)) {
         let slots = [];
         if (Array.isArray(slotsObj[dateKey])) {
           slots = slotsObj[dateKey];
         } else if (slotsObj[dateKey]?.slots) {
           slots = slotsObj[dateKey].slots;
         }
         
         const freeSlotTimes = new Set<string>();
         for (const slot of slots) {
           try {
             let timeStr = slot.includes('T') ? slot.split('T')[1].substring(0, 5) : slot.substring(0, 5);
             freeSlotTimes.add(timeStr);
           } catch (e) {}
         }
         availabilityMap[dateKey] = Array.from(freeSlotTimes);
      }
    }
  }

  return availabilityMap;
}

export async function bookAppointment(contactId: string, dateTime: string, title: string) {
  const calendarId = await getSecret('GHL_CALENDAR_ID');
  const locationId = await getSecret('GHL_LOCATION_ID');
  
  let duration = 30;
  try {
    const calInfo = await getCalendarInfo();
    if (calInfo.duration) duration = calInfo.duration;
  } catch (e) {
    console.warn('Could not fetch calendar duration, defaulting to 30 min');
  }

  const startTime = `${dateTime}+04:00`;
  const startDate = new Date(startTime);
  const endDate = new Date(startDate.getTime() + duration * 60 * 1000);

  const dubaiEnd = new Date(endDate.getTime() + (4 * 60 * 60 * 1000));
  const endTime = `${dubaiEnd.toISOString().replace('.000Z', '').substring(0, 19)}+04:00`;

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

  const data: any = await res.json();
  if (!res.ok) throw new Error(`Appointment creation failed: ${JSON.stringify(data)}`);
  
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
  } catch (e) {
    console.error('Failed to move opportunity to booked stage:', e);
  }

  return data;
}

export async function createOpportunity(contactId: string, title: string) {
    const locationId = await getSecret('GHL_LOCATION_ID');
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
    } catch (e) {
        console.error('Failed to create opportunity:', e);
    }
}

export async function sendAssessmentEmail(contactId: string, data: { tier: string, firstName: string, score: number }) {
    const subject = `Your Founder Pressure Scan Results`;
    const html = `<p>Hi ${data.firstName},</p><p>Your score is ${data.score} (${data.tier}).</p><p>Best,</p><p>Leaders Performance</p>`;
    return sendEmail(contactId, subject, html);
}

export async function sendAdminBriefing(data: any, adminIds: string[]) {
    const subject = `New Scan: ${data.name}`;
    const html = `<p>A new scan was completed by ${data.name} (${data.company}).</p><p>Score: ${data.score} (${data.tier})</p>`;
    for (const id of adminIds) {
        if (id) {
           await sendEmail(id, subject, html).catch(e => console.error(e));
        }
    }
}
