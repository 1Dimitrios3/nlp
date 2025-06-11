// detect ISO or D/M[/YY] dates
function isDateString(s) {
    // ISO yyyy-mm-dd or d/m/yy or d/m/yyyy
    return /^\d{4}-\d{2}-\d{2}$/.test(s)
        || /^\d{1,2}\/\d{1,2}\/(\d{2}|\d{4})$/.test(s);
}
// try to coerce into a JS number
function isNumericString(raw) {
    const cleaned = raw.replace(/\u00A0/g, ' ')
        .replace(/[^\d.,\-]/g, '')
        .replace(/\.(?=\d{3,}\b)/g, '') // drop thousands-dots
        .replace(/,/g, '.'); // commas → decimal
    const n = parseFloat(cleaned);
    return !isNaN(n);
}
/**
 * Parses dates in D/M/YY or D/M/YYYY and MM/DD/YYYY formats into YYYY-MM-DD.
 * Two-digit years are converted to 2000s (e.g. '12' -> '2012').
 * If month>12 implies US-style, swaps day/month.
 * Non-matching strings are returned as-is.
 */
function parseDate(dateString) {
    const regex = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
    const match = dateString.match(regex);
    if (match) {
        let [_, d, m, y] = match;
        let day = d.padStart(2, '0');
        let month = m.padStart(2, '0');
        // adjust if month>12 (treat as MM/DD/YYYY)
        const dayNum = parseInt(day, 10);
        const monthNum = parseInt(month, 10);
        if (monthNum > 12 && dayNum <= 12 && dayNum >= 1) {
            [day, month] = [month, day];
        }
        if (y.length === 2) {
            y = (parseInt(y, 10) + 2000).toString();
        }
        return `${y}-${month}-${day}`;
    }
    return dateString;
}
/**
 * Turn strings like "US$350,00" (i.e. 350 B) into an integer number of dollars.
 *
 * "US$350,00" → 350 → 350 * 1e9 → 350_000_000_000
 */
function parseValuation(raw) {
    // 1️⃣ normalize spaces & strip everything but digits, dot/comma, minus
    let s = raw.replace(/\u00A0/g, ' ').trim()
        .replace(/[^\d.,-]/g, '');
    // 2️⃣ disambiguate separators:
    if (s.includes('.') && s.includes(',')) {
        // e.g. "1.234,56" → "1234.56"
        s = s.replace(/\./g, '').replace(/,/g, '.');
    }
    else if (s.includes(',')) {
        // e.g. "350,00" → "350.00"
        s = s.replace(/,/g, '.');
    }
    const num = parseFloat(s);
    if (isNaN(num))
        return null;
    // 3️⃣ convert from “billions” → raw dollars
    return num * 1_000_000_000;
}
export { isDateString, isNumericString, parseDate, parseValuation };
