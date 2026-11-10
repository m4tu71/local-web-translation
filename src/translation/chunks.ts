/** One contiguous source slice and the exact separator that followed it. */
export interface TranslationChunk {
  readonly text: string;
  readonly separator: string;
}

export type InputTokenUpperBound = (text: string) => Promise<number>;

/**
 * Splits source text without losing or reordering any UTF-16 code units.
 * The caller supplies a conservative token upper bound for a complete prompt,
 * including the direction and PFML template.
 */
export async function splitTranslationText(
  text: string,
  maxInputTokens: number,
  getInputTokenUpperBound: InputTokenUpperBound,
): Promise<readonly TranslationChunk[]> {
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1) {
    throw new RangeError('maxInputTokens must be a positive safe integer.');
  }

  if (!text.length) return Object.freeze([]);

  const chunks: TranslationChunk[] = [];
  let start = 0;

  while (start < text.length) {
    const end = await findFittingEnd(text, start, maxInputTokens, getInputTokenUpperBound);
    if (end === undefined) {
      throw new RangeError(
        'A single Unicode character exceeds the available input token budget.',
      );
    }

    const boundary = chooseBoundary(text, start, end);
    const chunk = Object.freeze({
      text: text.slice(start, boundary.contentEnd),
      separator: text.slice(boundary.contentEnd, boundary.nextStart),
    });
    if (!chunk.text.length) {
      throw new Error('Translation chunk planning produced an empty chunk.');
    }

    chunks.push(chunk);
    start = boundary.nextStart;
  }

  return Object.freeze(chunks);
}

async function findFittingEnd(
  text: string,
  start: number,
  maxInputTokens: number,
  getInputTokenUpperBound: InputTokenUpperBound,
): Promise<number | undefined> {
  let low = nextCodePointEnd(text, start);
  let high = text.length;
  let fittingEnd: number | undefined;

  if (await getInputTokenUpperBound(text.slice(start, low)) > maxInputTokens) {
    return undefined;
  }
  fittingEnd = low;

  // Token counts are not guaranteed to grow exactly with source length. The
  // UTF-8 byte bound is monotonic for this pinned tokenizer, so binary search
  // finds the largest safe prefix in O(log n) measurements.
  while (low <= high) {
    const middle = previousCodePointStart(text, low + Math.floor((high - low) / 2));
    const candidateEnd = Math.max(low, middle);
    const upperBound = await getInputTokenUpperBound(text.slice(start, candidateEnd));
    if (upperBound <= maxInputTokens) {
      fittingEnd = candidateEnd;
      low = nextCodePointEnd(text, candidateEnd);
    } else {
      high = previousCodePointStart(text, candidateEnd - 1);
    }
  }

  return fittingEnd;
}

interface SplitBoundary {
  readonly contentEnd: number;
  readonly nextStart: number;
}

function chooseBoundary(text: string, start: number, maxEnd: number): SplitBoundary {
  return findParagraphBoundary(text, start, maxEnd) ??
    findSentenceBoundary(text, start, maxEnd) ??
    findWhitespaceBoundary(text, start, maxEnd) ??
    { contentEnd: maxEnd, nextStart: maxEnd };
}

function findParagraphBoundary(text: string, start: number, maxEnd: number): SplitBoundary | undefined {
  const pattern = /\r?\n[\t ]*\r?\n/g;
  pattern.lastIndex = start;
  let match: RegExpExecArray | null;
  let candidate: SplitBoundary | undefined;

  while ((match = pattern.exec(text)) !== null && match.index + match[0].length <= maxEnd) {
    if (match.index > start) {
      candidate = { contentEnd: match.index, nextStart: match.index + match[0].length };
    }
  }

  return candidate;
}

function findSentenceBoundary(text: string, start: number, maxEnd: number): SplitBoundary | undefined {
  const pattern = /[。！？]+|[.!?]+(?=\s|$)/gu;
  pattern.lastIndex = start;
  let match: RegExpExecArray | null;
  let candidate: SplitBoundary | undefined;

  while ((match = pattern.exec(text)) !== null && match.index + match[0].length <= maxEnd) {
    const boundary = match.index + match[0].length;
    if (boundary > start && boundary < text.length) {
      candidate = { contentEnd: boundary, nextStart: boundary };
    }
  }

  return candidate;
}

function findWhitespaceBoundary(text: string, start: number, maxEnd: number): SplitBoundary | undefined {
  const pattern = /\s+/gu;
  pattern.lastIndex = start;
  let match: RegExpExecArray | null;
  let candidate: SplitBoundary | undefined;

  while ((match = pattern.exec(text)) !== null && match.index + match[0].length <= maxEnd) {
    if (match.index > start && match.index + match[0].length < text.length) {
      candidate = { contentEnd: match.index, nextStart: match.index + match[0].length };
    }
  }

  return candidate;
}

function nextCodePointEnd(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function previousCodePointStart(text: string, index: number): number {
  let safeIndex = Math.max(0, Math.min(index, text.length));
  if (safeIndex > 0 && safeIndex < text.length) {
    const previous = text.charCodeAt(safeIndex - 1);
    const current = text.charCodeAt(safeIndex);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      safeIndex -= 1;
    }
  }
  return safeIndex;
}
