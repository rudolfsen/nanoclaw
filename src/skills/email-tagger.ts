import { addEmailTag, incrementLearnedTag, getLearnedTags } from '../db.js';
import { logger } from '../logger.js';

const STOPWORDS = new Set([
  'og',
  'i',
  'for',
  'med',
  'til',
  'fra',
  'på',
  'av',
  'er',
  'det',
  'en',
  'et',
  'den',
  'de',
  'som',
  'har',
  'var',
  'kan',
  'vil',
  'om',
  'vi',
  'du',
  'meg',
  'the',
  'and',
  'for',
  'you',
  'your',
  'with',
  'this',
  'that',
  'are',
  'was',
  'has',
  'have',
  'will',
  'can',
  'our',
  'not',
  'but',
  'from',
  're',
  'fw',
  'sv',
  'vs',
  'fwd',
]);

/**
 * Extract a readable tag from an email domain.
 * e.g. "beate.molander@gyldendal.no" → "Gyldendal"
 */
export function extractDomainTag(email: string): string | null {
  const domain = email.split('@')[1];
  if (!domain) return null;

  // Strip common prefixes/suffixes
  let name = domain
    .replace(/\.(com|no|org|net|io|co|se|dk|fi|eu|uk|de)$/i, '')
    .replace(
      /^(mail|email|noreply|no-reply|notifications?|alerts?|support|info|hello|news|newsletter|mailer|updates?)\./i,
      '',
    );

  // Skip generic email service domains
  const genericDomains = [
    'gmail',
    'outlook',
    'hotmail',
    'yahoo',
    'icloud',
    'live',
    'googlemail',
    'protonmail',
    'fastmail',
    'metamail',
    'global.metamail',
  ];
  if (genericDomains.some((g) => name.includes(g))) return null;

  // Skip automated senders
  if (/^(noreply|no-reply|donotreply|notifications?)$/i.test(name)) return null;

  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * Extract significant keywords from an email subject.
 */
export function extractSubjectKeywords(subject: string): string[] {
  // Strip reply/forward prefixes
  const cleaned = subject.replace(/^(Re|Fw|Fwd|SV|VS|Svar):\s*/gi, '').trim();

  return cleaned
    .split(/[\s\-_/,;:!?()[\]{}]+/)
    .map((w) => w.replace(/[^a-zA-ZæøåÆØÅ0-9]/g, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
}

// Map classification categories to Outlook master category display names
const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  viktig: 'Viktig',
  handling_kreves: 'Viktig',
  kvittering: 'Kvitteringer',
  nyhetsbrev: 'Nyhetsbrev',
  reklame: 'Reklame',
  annet: 'Annet',
};

/**
 * Generate tags for an email and store them.
 * Returns the list of tags applied.
 */
export function tagEmail(
  emailUid: string,
  source: string,
  category: string,
  from: string,
  subject: string,
): string[] {
  const tags: string[] = [];

  // Level 1: category tag (use display name for Outlook color matching)
  const displayCategory = CATEGORY_DISPLAY_NAMES[category] || category;
  tags.push(displayCategory);
  addEmailTag(emailUid, source, displayCategory);

  // Level 2: domain tag
  const domainTag = extractDomainTag(from);
  if (domainTag) {
    tags.push(domainTag);
    addEmailTag(emailUid, source, domainTag);

    // Count for learning
    incrementLearnedTag('domain', from.split('@')[1] || '', domainTag);
  }

  // Level 3: apply learned tags
  const learnedTags = getLearnedTags(3);
  const senderDomain = from.split('@')[1] || '';
  const keywords = extractSubjectKeywords(subject);

  for (const learned of learnedTags) {
    let matches = false;
    if (
      learned.pattern_type === 'domain' &&
      senderDomain.includes(learned.pattern_value)
    ) {
      matches = true;
    } else if (
      learned.pattern_type === 'subject_keyword' &&
      keywords.some(
        (k) => k.toLowerCase() === learned.pattern_value.toLowerCase(),
      )
    ) {
      matches = true;
    }
    if (matches && !tags.includes(learned.tag)) {
      tags.push(learned.tag);
      addEmailTag(emailUid, source, learned.tag);
    }
  }

  // Count subject keywords for future learning
  for (const keyword of keywords) {
    if (keyword.length >= 4) {
      const tag =
        keyword.charAt(0).toUpperCase() + keyword.slice(1).toLowerCase();
      incrementLearnedTag('subject_keyword', keyword.toLowerCase(), tag);
    }
  }

  logger.debug({ emailUid, tags }, 'Email tagged');
  return tags;
}
