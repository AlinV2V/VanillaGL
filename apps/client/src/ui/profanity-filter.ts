/** Asset conversion utility. */
import { getInterfaceCvars } from './interface-runtime';
import type { ChatEvent } from '../world';

const FILTERED_WORDS = [
  'fuck', 'fucking', 'fucker', 'shit', 'shitty', 'bitch', 'cunt', 'asshole',
  'bastard', 'dick', 'piss', 'slut', 'whore', 'faggot', 'nigger', 'retard',
];

// One alternation, longest-first so "fucking" masks fully instead of leaving "ing".
const FILTER_PATTERN = new RegExp(
  `\\b(${[...FILTERED_WORDS].sort((a, b) => b.length - a.length).join('|')})\\b`,
  'gi',
);

export function maskProfanity(message: string): string {
  return message.replace(FILTER_PATTERN, (word) => '*'.repeat(word.length));
}

/**
 * Returns the event unchanged when the filter is off or the text is clean, so the common
 * path neither allocates nor touches the message.
 */
export function applyProfanityFilter(event: ChatEvent): ChatEvent {
  if (Number(getInterfaceCvars().profanityFilter) !== 1) return event;
  const message = event.message;
  if (!message) return event;
  const masked = maskProfanity(message);
  return masked === message ? event : { ...event, message: masked };
}
