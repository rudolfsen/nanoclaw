const MAX_BODY_LENGTH = 500;

interface EmailContent {
  from: string;
  subject: string;
  body: string;
}

export function sanitizeEmailForAgent(email: EmailContent): string {
  const truncatedBody =
    email.body.length > MAX_BODY_LENGTH
      ? email.body.slice(0, MAX_BODY_LENGTH) + '...[truncated]'
      : email.body;

  return [
    '<external-email>',
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    '',
    truncatedBody,
    '</external-email>',
  ].join('\n');
}
