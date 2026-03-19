import { describe, it, expect, vi } from 'vitest';
import { ErrorNotifier, formatErrorMessage } from '../src/error-notifier';

describe('ErrorNotifier', () => {
  it('should format error messages with context', () => {
    const msg = formatErrorMessage('IMAP', new Error('Connection lost'));
    expect(msg).toContain('IMAP');
    expect(msg).toContain('Connection lost');
  });

  it('should call send function with formatted message', async () => {
    const sendFn = vi.fn();
    const notifier = new ErrorNotifier(sendFn);
    await notifier.notify('IMAP', new Error('Connection lost'));
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('IMAP'));
  });

  it('should not send duplicate errors within cooldown', async () => {
    const sendFn = vi.fn();
    const notifier = new ErrorNotifier(sendFn, 1000);
    await notifier.notify('IMAP', new Error('Connection lost'));
    await notifier.notify('IMAP', new Error('Connection lost'));
    expect(sendFn).toHaveBeenCalledTimes(1);
  });
});
