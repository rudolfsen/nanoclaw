import { google } from 'googleapis';

export interface CalendarEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
}

export interface ParsedEventRequest {
  summary: string;
  hour: number | null;
  day: string | null;
}

export interface CreateEventDetails {
  summary: string;
  start: string; // ISO datetime string
  end: string;   // ISO datetime string
  location?: string;
  description?: string;
}

/**
 * Formats a Google Calendar event object into a human-readable string.
 */
export function formatEvent(event: CalendarEvent): string {
  const summary = event.summary ?? '(No title)';
  const startRaw = event.start?.dateTime ?? event.start?.date ?? '';
  const endRaw = event.end?.dateTime ?? event.end?.date ?? '';

  const formatTime = (iso: string): string => {
    if (!iso) return '';
    const match = iso.match(/T(\d{2}:\d{2})/);
    return match ? match[1] : iso;
  };

  const startTime = formatTime(startRaw);
  const endTime = formatTime(endRaw);

  const parts: string[] = [summary];
  if (startTime) {
    parts.push(endTime ? `${startTime}–${endTime}` : startTime);
  }
  if (event.location) {
    parts.push(`@ ${event.location}`);
  }

  return parts.join(' | ');
}

const NORWEGIAN_DAY_KEYWORDS: Record<string, string> = {
  mandag: 'monday',
  tirsdag: 'tuesday',
  onsdag: 'wednesday',
  torsdag: 'thursday',
  fredag: 'friday',
  lørdag: 'saturday',
  søndag: 'sunday',
  idag: 'today',
  imorgen: 'tomorrow',
};

/**
 * Basic parsing of Norwegian natural language event requests.
 * Extracts summary, hour, and day keyword.
 */
export function parseEventRequest(text: string): ParsedEventRequest {
  const lower = text.toLowerCase();

  // Extract hour: "kl 10", "kl. 10", "kl10", or standalone number after "kl"
  let hour: number | null = null;
  const hourMatch = lower.match(/\bkl\.?\s*(\d{1,2})\b/);
  if (hourMatch) {
    hour = parseInt(hourMatch[1], 10);
  }

  // Extract day keyword
  let day: string | null = null;
  for (const [norw, eng] of Object.entries(NORWEGIAN_DAY_KEYWORDS)) {
    if (lower.includes(norw)) {
      day = eng;
      break;
    }
  }

  // Build summary: strip command words and time/day tokens, keep meaningful words
  const stopWords = new Set([
    'book', 'lag', 'opprett', 'sett', 'opp', 'møte', 'med', 'et', 'en', 'et',
    ...Object.keys(NORWEGIAN_DAY_KEYWORDS),
  ]);

  const tokens = text
    .replace(/\bkl\.?\s*\d{1,2}\b/gi, '')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !stopWords.has(t.toLowerCase()));

  const summary = tokens.join(' ').trim() || text.trim();

  return { summary, hour, day };
}

/**
 * Creates an authenticated Google Calendar API client using environment variables:
 * GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 */
export function getCalendarClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing required environment variables: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN',
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  return google.calendar({ version: 'v3', auth });
}

/**
 * Lists events for a given date (YYYY-MM-DD).
 */
export async function listEvents(date: string): Promise<CalendarEvent[]> {
  const calendar = getCalendarClient();

  const timeMin = new Date(`${date}T00:00:00`).toISOString();
  const timeMax = new Date(`${date}T23:59:59`).toISOString();

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (response.data.items ?? []) as CalendarEvent[];
}

/**
 * Creates a new calendar event.
 */
export async function createEvent(details: CreateEventDetails): Promise<CalendarEvent> {
  const calendar = getCalendarClient();

  const response = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: details.summary,
      location: details.location,
      description: details.description,
      start: { dateTime: details.start },
      end: { dateTime: details.end },
    },
  });

  return response.data as CalendarEvent;
}
