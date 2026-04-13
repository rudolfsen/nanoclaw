import { describe, it, expect } from 'vitest';
import { OutlookGraphClient } from '../src/channels/outlook.js';

describe('OutlookGraphClient', () => {
  it('can be instantiated with an access token', () => {
    const client = new OutlookGraphClient('fake-token');
    expect(client).toBeDefined();
  });
});
