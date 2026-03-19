import { describe, it, expect } from 'vitest';
import { buildSearchQuery } from '../src/skills/google-drive';

describe('Google Drive', () => {
  it('should build a Drive search query from natural language', () => {
    const query = buildSearchQuery('kvitteringer fra mars 2026');
    expect(query).toContain("name contains 'kvittering'");
  });

  it('should build query for PDF files', () => {
    const query = buildSearchQuery('alle PDF-filer');
    expect(query).toContain("mimeType='application/pdf'");
  });
});
