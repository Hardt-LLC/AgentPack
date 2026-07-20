const SECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function validateSectionId(sectionId: string): void {
  if (!SECTION_ID_PATTERN.test(sectionId)) {
    throw new Error(
      `invalid section id "${sectionId}": must match ${SECTION_ID_PATTERN.toString()}`,
    );
  }
}

function beginMarker(sectionId: string): string {
  return `<!-- agentpack:begin ${sectionId} -->`;
}

function endMarker(sectionId: string): string {
  return `<!-- agentpack:end ${sectionId} -->`;
}

interface SectionMatch {
  /** Start index of the whole block (begin marker included). */
  start: number;
  /** End index of the whole block (end marker excluded). */
  end: number;
  /** The body between the markers, without surrounding newlines. */
  content: string;
}

function findSection(text: string, sectionId: string): SectionMatch | undefined {
  const pattern = new RegExp(
    `${escapeRegExp(beginMarker(sectionId))}\\r?\\n([\\s\\S]*?)\\r?\\n${escapeRegExp(endMarker(sectionId))}`,
  );
  const match = pattern.exec(text);
  if (!match) return undefined;
  return { start: match.index, end: match.index + match[0].length, content: match[1] ?? "" };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalBlock(sectionId: string, content: string): string {
  const body = content.replace(/\s+$/u, "");
  return `${beginMarker(sectionId)}\n${body}\n${endMarker(sectionId)}`;
}

function ensureSingleTrailingNewline(text: string): string {
  return `${text.replace(/\s+$/u, "")}\n`;
}

/**
 * Insert or replace a managed section. Idempotent: upserting the same content
 * twice yields the same document and never duplicates the section.
 */
export function upsertManagedSection(
  existing: string | undefined,
  sectionId: string,
  content: string,
): string {
  validateSectionId(sectionId);
  const text = existing ?? "";
  const block = canonicalBlock(sectionId, content);
  const found = findSection(text, sectionId);
  if (found) {
    const next = text.slice(0, found.start) + block + text.slice(found.end);
    return ensureSingleTrailingNewline(next);
  }
  const base = text.replace(/\s+$/u, "");
  const next = base === "" ? block : `${base}\n\n${block}`;
  return ensureSingleTrailingNewline(next);
}

/** Remove a managed section and collapse runs of more than two newlines. */
export function removeManagedSection(existing: string, sectionId: string): string {
  validateSectionId(sectionId);
  const found = findSection(existing, sectionId);
  if (!found) return existing;
  let next = existing.slice(0, found.start) + existing.slice(found.end);
  next = next.replace(/\n{3,}/g, "\n\n");
  return next === "" || next.trim() === "" ? "" : ensureSingleTrailingNewline(next);
}

/** List managed section ids in document order. */
export function listManagedSections(existing: string): string[] {
  const pattern = /<!-- agentpack:begin ([a-z0-9][a-z0-9-]*) -->/g;
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(existing)) !== null) {
    ids.push(match[1]!);
  }
  return ids;
}

/** Return the body of a managed section, or undefined when absent. */
export function sectionContent(existing: string, sectionId: string): string | undefined {
  validateSectionId(sectionId);
  return findSection(existing, sectionId)?.content;
}
