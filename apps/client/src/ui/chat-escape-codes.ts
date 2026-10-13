/** Asset conversion utility. */
export type ChatSegment = { text: string; color?: string };

const COLOR = /^\|c([0-9a-f]{8})/i;
const RESET = /^\|r/i;
const LINK_OPEN = /^\|H[^|]*\|h/i;
const LINK_CLOSE = /^\|h/i;
const TEXTURE = /^\|T[^|]*\|t/i;

/**
 * Split a chat line into coloured runs. `defaultColor` is the channel colour the line would have
 * had; segments outside any `|c` keep it.
 */
export function parseChatEscapes(raw: string, defaultColor?: string): ChatSegment[] {
  const segments: ChatSegment[] = [];
  const stack: (string | undefined)[] = [];
  let current = defaultColor;
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (!buffer) return;
    segments.push(current ? { text: buffer, color: current } : { text: buffer });
    buffer = '';
  };

  while (index < raw.length) {
    if (raw[index] === '|') {
      const rest = raw.slice(index);
      const color = COLOR.exec(rest);
      if (color) {
        flush();
        stack.push(current);
        // AARRGGBB — drop the alpha byte, the client does too.
        current = `#${color[1].slice(2)}`;
        index += color[0].length;
        continue;
      }
      if (RESET.test(rest)) {
        flush();
        current = stack.pop() ?? defaultColor;
        index += 2;
        continue;
      }
      const texture = TEXTURE.exec(rest);
      if (texture) { index += texture[0].length; continue; }
      const linkOpen = LINK_OPEN.exec(rest);
      if (linkOpen) { index += linkOpen[0].length; continue; }
      if (LINK_CLOSE.test(rest)) { index += 2; continue; }
      // A literal pipe that is not a sequence we know: `||` escapes one, otherwise keep it.
      if (rest.startsWith('||')) { buffer += '|'; index += 2; continue; }
      buffer += '|';
      index += 1;
      continue;
    }
    buffer += raw[index];
    index += 1;
  }
  flush();
  return segments;
}

/** The line with all markup removed — for the DOM log, logging and tests. */
export const stripChatEscapes = (raw: string) =>
  parseChatEscapes(raw).map((segment) => segment.text).join('');
