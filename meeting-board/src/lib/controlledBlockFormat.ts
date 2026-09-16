export type ControlledBlockAlignment = "center" | "right";

const OPENING = /^<div data-omia-align="(center|right)">$/;
const CLOSING = "</div>";

export function parseControlledAlignmentOpening(source: string): ControlledBlockAlignment | null {
  const match = source.match(OPENING);
  return match ? match[1] as ControlledBlockAlignment : null;
}

export function controlledAlignmentOpening(alignment: ControlledBlockAlignment): string {
  return `<div data-omia-align="${alignment}">`;
}

export function controlledAlignmentClosing(): string {
  return CLOSING;
}

/**
 * Remove only canonical, single-paragraph alignment wrappers before the generic
 * raw-HTML audit. Unknown attributes, left wrappers and multi-block containers
 * deliberately remain in the source and therefore fail closed.
 */
export function stripControlledAlignmentBlocksForSafety(source: string): { ok: boolean; source: string } {
  const canonical = /^<div data-omia-align="(center|right)">\n\n((?:(?!\n\s*\n)[\s\S])*)\n\n<\/div>$/gm;
  const stripped = source.replace(canonical, (_whole, _alignment: string, body: string) => body);
  const hasAlignmentMarker = /<\/?div\b[^>]*data-omia-align|<\/div>/.test(stripped);
  return { ok: !hasAlignmentMarker, source: stripped };
}
