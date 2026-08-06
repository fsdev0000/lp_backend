"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canSuggestBooking = exports.initialBookingState = void 0;
const initialBookingState = () => ({
    status: 'not_started',
    calendarOpened: false,
    bookingConfirmed: false,
    attemptCount: 0,
});
exports.initialBookingState = initialBookingState;
const canSuggestBooking = (state) => {
    return !state.calendarOpened && !state.bookingConfirmed && state.attemptCount < 2;
};
exports.canSuggestBooking = canSuggestBooking;
