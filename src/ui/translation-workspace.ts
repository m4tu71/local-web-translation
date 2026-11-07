import type { Language, TranslationDirection } from '../translation/input.ts';

export const DEFAULT_DIRECTION: TranslationDirection = Object.freeze({
  sourceLanguage: 'ja',
  targetLanguage: 'en',
});

export function changeSourceLanguage(
  direction: TranslationDirection,
  sourceLanguage: Language,
): TranslationDirection {
  if (sourceLanguage === direction.targetLanguage) {
    return Object.freeze({ sourceLanguage, targetLanguage: direction.sourceLanguage });
  }
  return Object.freeze({ ...direction, sourceLanguage });
}

export function changeTargetLanguage(
  direction: TranslationDirection,
  targetLanguage: Language,
): TranslationDirection {
  if (targetLanguage === direction.sourceLanguage) {
    return Object.freeze({ sourceLanguage: direction.targetLanguage, targetLanguage });
  }
  return Object.freeze({ ...direction, targetLanguage });
}

export function swapDirection(direction: TranslationDirection): TranslationDirection {
  return Object.freeze({
    sourceLanguage: direction.targetLanguage,
    targetLanguage: direction.sourceLanguage,
  });
}

/** Keeps a cleared input available for one in-page undo while the field stays empty. */
export class InputUndoHistory {
  private clearedText?: string;

  clear(text: string): boolean {
    if (!text) return false;
    this.clearedText = text;
    return true;
  }

  recordEdit(text: string): void {
    if (text) this.clearedText = undefined;
  }

  canUndo(currentText: string): boolean {
    return currentText.length === 0 && this.clearedText !== undefined;
  }

  undo(currentText: string): string | undefined {
    if (!this.canUndo(currentText)) return undefined;
    const previousText = this.clearedText;
    this.clearedText = undefined;
    return previousText;
  }
}

/** Ignores clipboard success or failure from an output that is no longer current. */
export class AsyncFeedbackGuard {
  private revision = 0;

  begin(): number {
    this.revision++;
    return this.revision;
  }

  invalidate(): void {
    this.revision++;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}
