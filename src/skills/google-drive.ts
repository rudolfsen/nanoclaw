import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

export interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
}

export interface DriveFileContent {
  metadata: DriveFile;
  content?: string;
}

/** Maps Norwegian keywords to Google Drive query clauses. */
const KEYWORD_MAP: Array<{ pattern: RegExp; clause: string }> = [
  { pattern: /\bkvittering(er)?\b/i, clause: "name contains 'kvittering'" },
  { pattern: /\bpdf(-filer?)?\b/i, clause: "mimeType='application/pdf'" },
  { pattern: /\bfaktura(er)?\b/i, clause: "name contains 'faktura'" },
  { pattern: /\bkontrakt(er)?\b/i, clause: "name contains 'kontrakt'" },
  { pattern: /\bbilde(r)?\b/i, clause: "mimeType contains 'image/'" },
  { pattern: /\bdokument(er)?\b/i, clause: "mimeType='application/vnd.google-apps.document'" },
  { pattern: /\bregneark\b/i, clause: "mimeType='application/vnd.google-apps.spreadsheet'" },
  { pattern: /\bpresentasjon(er)?\b/i, clause: "mimeType='application/vnd.google-apps.presentation'" },
];

/**
 * Converts a natural language query (Norwegian/English) to Google Drive API query syntax.
 * Multiple clauses are joined with " and ".
 */
export function buildSearchQuery(text: string): string {
  const clauses: string[] = [];

  for (const { pattern, clause } of KEYWORD_MAP) {
    if (pattern.test(text)) {
      clauses.push(clause);
    }
  }

  // Extract quoted terms as explicit name searches
  const quotedTerms = text.match(/"([^"]+)"/g);
  if (quotedTerms) {
    for (const term of quotedTerms) {
      const inner = term.slice(1, -1);
      clauses.push(`name contains '${inner}'`);
    }
  }

  // Fall back to a full-text search if no structured clauses matched
  if (clauses.length === 0) {
    clauses.push(`fullText contains '${text.replace(/'/g, "\\'")}'`);
  }

  // Exclude trashed files by default
  clauses.push('trashed = false');

  return clauses.join(' and ');
}

/**
 * Creates an authenticated Google Drive API client using environment variables:
 * GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 */
export function getDriveClient() {
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

  return google.drive({ version: 'v3', auth });
}

/**
 * Searches Google Drive using the given query string (Drive API query syntax).
 * Returns a list of matching file metadata objects.
 */
export async function searchFiles(query: string): Promise<DriveFile[]> {
  const drive = getDriveClient();

  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime, size, parents)',
    pageSize: 100,
  });

  return (response.data.files ?? []) as DriveFile[];
}

/**
 * Reads file metadata and, for text-based files, exports content as plain text.
 * Binary files (PDFs, images) return metadata only.
 */
export async function readFile(fileId: string): Promise<DriveFileContent> {
  const drive = getDriveClient();

  const metaResponse = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, createdTime, modifiedTime, size, parents',
  });

  const metadata = metaResponse.data as DriveFile;
  const mimeType = metadata.mimeType ?? '';

  // Export Google Docs native types as plain text
  const exportableMimes: Record<string, string> = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };

  if (exportableMimes[mimeType]) {
    const exportResponse = await drive.files.export(
      { fileId, mimeType: exportableMimes[mimeType] },
      { responseType: 'text' },
    );
    return { metadata, content: exportResponse.data as string };
  }

  // For plain text files, download content directly
  if (mimeType.startsWith('text/')) {
    const contentResponse = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' },
    );
    return { metadata, content: contentResponse.data as string };
  }

  // Binary / unsupported types — return metadata only
  return { metadata };
}

/**
 * Uploads a local file to Google Drive, optionally placing it in the given folder.
 * Returns the created DriveFile metadata.
 */
export async function uploadFile(
  localPath: string,
  folderId?: string,
): Promise<DriveFile> {
  const drive = getDriveClient();

  const fileName = path.basename(localPath);
  const fileStream = fs.createReadStream(localPath);

  const requestBody: { name: string; parents?: string[] } = { name: fileName };
  if (folderId) {
    requestBody.parents = [folderId];
  }

  const response = await drive.files.create({
    requestBody,
    media: {
      body: fileStream,
    },
    fields: 'id, name, mimeType, createdTime, modifiedTime, size, parents',
  });

  return response.data as DriveFile;
}
