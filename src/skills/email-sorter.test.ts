import { describe, it, expect } from 'vitest';
import { categorizeEmail } from './email-sorter.js';

describe('categorizeEmail', () => {
  it('noreply@shopify.com is NOT viktig', () => {
    const result = categorizeEmail({
      from: 'noreply@shopify.com',
      subject: 'Your order has been received',
      body: 'Thank you for your purchase.',
    });
    expect(result.category).not.toBe('viktig');
  });

  it('real person email with personal subject → annet (needsAI)', () => {
    const result = categorizeEmail({
      from: 'ola.nordmann@gmail.com',
      subject: 'Hei, kan vi møtes i morgen?',
      body: 'Jeg lurte på om du har tid til et møte.',
    });
    expect(result.category).toBe('annet');
    expect(result.needsAI).toBe(true);
  });

  it('email with unsubscribe link in body → nyhetsbrev', () => {
    const result = categorizeEmail({
      from: 'news@example.com',
      subject: 'This week in tech',
      body: 'Click here to unsubscribe from this mailing list.',
    });
    expect(result.category).toBe('nyhetsbrev');
  });

  it('receipt@paypal.com → kvittering', () => {
    const result = categorizeEmail({
      from: 'receipt@paypal.com',
      subject: 'Payment confirmed',
      body: 'You sent a payment of $50.00.',
    });
    expect(result.category).toBe('kvittering');
  });

  it('campaign email with sale/offer keywords → reklame', () => {
    const result = categorizeEmail({
      from: 'promo@somestore.com',
      subject: 'Big sale — 50% off everything!',
      body: 'Our biggest sale of the year. Special offer ends Sunday.',
    });
    expect(result.category).toBe('reklame');
  });

  it('store+12345@t.shopifyemail.com → annet', () => {
    const result = categorizeEmail({
      from: 'store+12345@t.shopifyemail.com',
      subject: 'Your order is on its way',
      body: 'Tracking info enclosed.',
    });
    expect(result.category).toBe('annet');
  });

  it('invoice keyword in subject → kvittering', () => {
    const result = categorizeEmail({
      from: 'billing@somecompany.com',
      subject: 'Invoice #4321 for your account',
      body: 'Please find your invoice attached.',
    });
    expect(result.category).toBe('kvittering');
  });

  it('campaign keyword in body → reklame', () => {
    const result = categorizeEmail({
      from: 'marketing@shop.com',
      subject: 'New arrivals',
      body: 'Check out our new summer campaign with great tilbud.',
    });
    expect(result.category).toBe('reklame');
  });

  it('unknown automated sender → annet (no needsAI)', () => {
    const result = categorizeEmail({
      from: 'notifications@randomservice.com',
      subject: 'Your account activity',
      body: 'Here is a summary of recent activity.',
    });
    expect(result.category).toBe('annet');
    expect(result.needsAI).toBe(false);
  });

  it('no-reply sender → NOT viktig', () => {
    const result = categorizeEmail({
      from: 'no-reply@example.com',
      subject: 'Account update',
      body: 'Your settings have been updated.',
    });
    expect(result.category).not.toBe('viktig');
  });

  it('nyhetsbrev keyword in subject → nyhetsbrev', () => {
    const result = categorizeEmail({
      from: 'news@avisen.no',
      subject: 'Nyhetsbrev for april',
      body: 'Les de siste nyhetene fra oss.',
    });
    expect(result.category).toBe('nyhetsbrev');
  });

  it('faktura keyword → kvittering', () => {
    const result = categorizeEmail({
      from: 'faktura@telenor.no',
      subject: 'Din faktura er klar',
      body: 'Se vedlagt faktura.',
    });
    expect(result.category).toBe('kvittering');
  });
});
