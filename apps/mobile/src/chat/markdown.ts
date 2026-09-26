// A deliberately small Markdown reader: paragraphs, bold, inline code, bullet and numbered lists,
// quotes and fenced code. No HTML, no link targets and no raw provider markup reaches the renderer.
export type MdSpan = { kind: 'text' | 'bold' | 'code'; text: string };
export type MdBlock =
  | { kind: 'paragraph'; spans: MdSpan[] }
  | { kind: 'list'; ordered: boolean; items: MdSpan[][] }
  | { kind: 'quote'; spans: MdSpan[] }
  | { kind: 'code'; language: string; text: string };

const bulletLine = /^\s*[-*+•]\s+(.*)$/;
const orderedLine = /^\s*\d+[.)]\s+(.*)$/;
const quoteLine = /^\s*>\s?/;
const fenceLine = /^\s*```/;
const fenceOpen = /^\s*```\s*([\w+#.-]*)\s*$/;
const fenceClose = /^\s*```\s*$/;

function append(spans: MdSpan[], span: MdSpan): void {
  const previous = spans[spans.length - 1];
  if (span.kind === 'text' && previous?.kind === 'text') previous.text += span.text;
  else spans.push(span);
}

export function parseInline(source: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2);
      if (end > index + 2) {
        append(spans, { kind: 'bold', text: source.slice(index + 2, end) });
        index = end + 2;
        continue;
      }
    }
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index + 1) {
        append(spans, { kind: 'code', text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    let next = index + 1;
    while (next < source.length && !source.startsWith('**', next) && source[next] !== '`') next += 1;
    append(spans, { kind: 'text', text: source.slice(index, next) });
    index = next;
  }
  return spans;
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (fenceLine.test(line)) {
      const language = fenceOpen.exec(line)?.[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !fenceClose.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const bullet = bulletLine.exec(line);
    const ordered = orderedLine.exec(line);
    if (bullet || ordered) {
      const wanted = ordered ? orderedLine : bulletLine;
      const items: MdSpan[][] = [];
      while (index < lines.length) {
        const match = wanted.exec(lines[index]!);
        if (!match) break;
        items.push(parseInline(match[1] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: Boolean(ordered), items });
      continue;
    }
    if (quoteLine.test(line)) {
      const body: string[] = [];
      while (index < lines.length && quoteLine.test(lines[index]!)) {
        body.push(lines[index]!.replace(quoteLine, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', spans: parseInline(body.join('\n')) });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      if (!current.trim() || fenceLine.test(current) || bulletLine.test(current) || orderedLine.test(current) || quoteLine.test(current)) break;
      body.push(current);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(body.join('\n')) });
  }
  return blocks;
}
