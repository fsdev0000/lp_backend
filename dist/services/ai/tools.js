"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.geminiTools = void 0;
exports.executeBackendTool = executeBackendTool;
const ghl_1 = require("../ghl");
// Define the tool schemas for Gemini
exports.geminiTools = [
    {
        type: "function",
        function: {
            name: "get_available_times",
            description: "Gets available time slots for a consultation.",
            parameters: {
                type: "object",
                properties: {
                    date: {
                        type: "string",
                        description: "The date to check in YYYY-MM-DD format (e.g. 2026-07-29)"
                    }
                },
                required: ["date"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "book_appointment",
            description: "Books an appointment for the user at the specified time.",
            parameters: {
                type: "object",
                properties: {
                    dateTime: {
                        type: "string",
                        description: "The ISO 8601 date and time to book (e.g. 2026-07-29T10:00:00Z)"
                    },
                    title: {
                        type: "string",
                        description: "A short title for the booking (e.g. Founder Pressure Scan Review)"
                    }
                },
                required: ["dateTime", "title"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "trigger_client_booking_ui",
            description: "Triggers the frontend calendar UI so the user can select their own time slot visually.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    }
];
// Execute the tool locally in the backend
async function executeBackendTool(name, args, contactId) {
    try {
        switch (name) {
            case 'get_available_times':
                const slots = await (0, ghl_1.getFreeSlots)(args.date);
                return JSON.stringify({ slots });
            case 'book_appointment':
                if (!contactId)
                    return JSON.stringify({ error: "Missing contactId for booking." });
                const result = await (0, ghl_1.bookAppointment)(contactId, args.dateTime, args.title);
                return JSON.stringify({ success: true, result });
            case 'trigger_client_booking_ui':
                return JSON.stringify({ action: "SHOW_AVAILABLE_TIMES", status: "UI Triggered" });
            default:
                return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
    }
    catch (err) {
        console.error(`Tool execution error for ${name}:`, err);
        return JSON.stringify({ error: err.message });
    }
}
