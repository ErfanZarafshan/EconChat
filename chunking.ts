/**
 * Chunking strategy for econ textbooks.
 *
 * Goals:
 *   1. Never split a paragraph mid-sentence. Equations and proofs lose
 *      meaning when chopped.
 *   2. Aim for ~1200 tokens per chunk (roughly 900 words). Larger than
 *      typical RAG chunks because mathematical context is dense.
 *   3. Overlap consecutive chunks by ~150 tokens (one paragraph) so a
 *      derivation that straddles a chunk boundary appears in both.
 *   4. Preserve chapter/section/page metadata for citations.
 *
 * We use a cheap token approximation: 1 token ≈ 4 characters of English.
 * For exact counts you'd use `tiktoken`, but the approximation is fine
 * for chunking decisions.
 */

const TARGET_CHARS = 4800;   // ~1200 tokens
const MAX_CHARS = 6400;      // ~1600 tokens (hard ceiling)
const OVERLAP_CHARS = 600;   // ~150 tokens of overlap

export type RawChunk = {
  content: string;
  chapter?: string;
  section?: string;
  page?: number;
};

export type Paragraph = {
  text: string;
  chapter?: string;
  section?: string;
  page?: number;
};

/**
 * Split a paragraph stream into chunks. The caller is responsible for
 * producing the paragraph stream from the PDF — that's where book-
 * specific parsing lives (chapter detection, page tracking, etc.).
 */
export function chunkParagraphs(paragraphs: Paragraph[]): RawChunk[] {
  const chunks: RawChunk[] = [];
  let buffer: Paragraph[] = [];
  let bufferLen = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const content = buffer.map(p => p.text).join('\n\n');
    // Inherit metadata from the first paragraph in the chunk.
    chunks.push({
      content,
      chapter: buffer[0].chapter,
      section: buffer[0].section,
      page: buffer[0].page,
    });

    // Build overlap: keep the last paragraphs that sum to ~OVERLAP_CHARS.
    const overlap: Paragraph[] = [];
    let overlapLen = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      overlap.unshift(buffer[i]);
      overlapLen += buffer[i].text.length;
      if (overlapLen >= OVERLAP_CHARS) break;
    }
    buffer = overlap;
    bufferLen = overlapLen;
  };

  for (const p of paragraphs) {
    // If this single paragraph is huge (a long proof), it becomes its
    // own chunk after flushing whatever was buffered.
    if (p.text.length > MAX_CHARS) {
      flush();
      chunks.push({
        content: p.text,
        chapter: p.chapter,
        section: p.section,
        page: p.page,
      });
      buffer = [];
      bufferLen = 0;
      continue;
    }

    if (bufferLen + p.text.length > TARGET_CHARS && bufferLen >= TARGET_CHARS / 2) {
      flush();
    }

    buffer.push(p);
    bufferLen += p.text.length;
  }
  flush();

  // Final flush may produce an overlap-only chunk; drop tiny tails.
  return chunks.filter(c => c.content.length >= 200);
}
