"use strict";
/**
 * Calendar Invitation (.ics) Generator & Universal Web Calendar Links
 * Leaders Performance — Strategic Review
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateIcsContent = generateIcsContent;
exports.generateGoogleCalendarUrl = generateGoogleCalendarUrl;
exports.generateOutlookCalendarUrl = generateOutlookCalendarUrl;
function formatIcsDate(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
/**
 * Generates an RFC 5545 compliant iCalendar (.ics) string.
 */
function generateIcsContent(event) {
    const dtStamp = formatIcsDate(new Date());
    const dtStart = formatIcsDate(event.start);
    const dtEnd = formatIcsDate(event.end);
    const status = event.status || 'CONFIRMED';
    const sequence = event.sequence ?? 0;
    // Escape special ICS characters in text fields
    const cleanSummary = event.title.replace(/[,;\\]/g, '\\$&').replace(/\n/g, '\\n');
    const cleanDescription = event.description.replace(/[,;\\]/g, '\\$&').replace(/\n/g, '\\n');
    const cleanLocation = event.location.replace(/[,;\\]/g, '\\$&').replace(/\n/g, '\\n');
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Leaders Performance//Masterclass Strategic Review//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        `UID:${event.uid}`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${cleanSummary}`,
        `DESCRIPTION:${cleanDescription}`,
        `LOCATION:${cleanLocation}`,
    ];
    if (event.meetingUrl) {
        lines.push(`URL:${event.meetingUrl}`);
    }
    lines.push(`ORGANIZER;CN=${event.organizerName}:mailto:${event.organizerEmail}`, `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=${event.attendeeName}:mailto:${event.attendeeEmail}`, `STATUS:${status}`, `SEQUENCE:${sequence}`, 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder: Strategic Review with Lionel Eersteling in 15 minutes', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
}
/**
 * Generates one-click "Add to Google Calendar" web link
 */
function generateGoogleCalendarUrl(event) {
    const dates = `${formatIcsDate(event.start)}/${formatIcsDate(event.end)}`;
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: event.title,
        dates,
        details: event.description,
        location: event.location,
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
/**
 * Generates one-click "Add to Outlook Live / 365" web link
 */
function generateOutlookCalendarUrl(event) {
    const params = new URLSearchParams({
        path: '/calendar/action/compose',
        rru: 'addevent',
        subject: event.title,
        startdt: event.start.toISOString(),
        enddt: event.end.toISOString(),
        body: event.description,
        location: event.location,
    });
    return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}
