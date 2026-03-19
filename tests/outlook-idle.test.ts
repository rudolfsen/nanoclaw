import { describe, it, expect, vi } from 'vitest';
import { OutlookChannel } from '../src/channels/outlook';

describe('OutlookChannel IDLE and Reconnect', () => {
  it('should throw when starting idle without connection', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });
    await expect(
      channel.startIdleWatch('INBOX', vi.fn())
    ).rejects.toThrow('Not connected');
  });

  it('should attempt reconnect on connection error', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });

    const connectSpy = vi.spyOn(channel, 'connect').mockRejectedValue(new Error('Connection refused'));

    await expect(channel.reconnectWithRetry(3, 10)).rejects.toThrow();
    expect(connectSpy).toHaveBeenCalledTimes(3);
  });

  it('should succeed on reconnect after transient failure', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });

    let attempts = 0;
    vi.spyOn(channel, 'connect').mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error('Connection refused');
    });

    await channel.reconnectWithRetry(5, 10);
    expect(attempts).toBe(3);
  });
});
