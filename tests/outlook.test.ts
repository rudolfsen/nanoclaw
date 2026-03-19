import { describe, it, expect } from 'vitest';
import { OutlookChannel } from '../src/channels/outlook';

describe('OutlookChannel', () => {
  it('should create an instance with IMAP config', () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'test-app-password' },
    });
    expect(channel).toBeDefined();
    expect(channel.name).toBe('outlook');
  });

  it('should parse email into standard message format', () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });

    const rawEmail = {
      uid: 123,
      from: { address: 'sender@example.com', name: 'Sender' },
      subject: 'Test Subject',
      text: 'Hello world',
      date: new Date('2026-03-19'),
    };

    const message = channel.parseEmail(rawEmail);
    expect(message.from).toBe('sender@example.com');
    expect(message.subject).toBe('Test Subject');
    expect(message.body).toBe('Hello world');
  });

  it('should throw when fetching without connection', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });
    await expect(channel.fetchRecent()).rejects.toThrow('Not connected');
  });

  it('should throw when moving without connection', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });
    await expect(channel.moveToFolder(1, 'Archive')).rejects.toThrow('Not connected');
  });
});
