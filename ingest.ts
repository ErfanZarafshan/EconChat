/**
 * Ingestion script. Usage:
 *
 *   npx tsx scripts/ingest.ts \
 *     --pdf ./books/ljungqvist-sargent.pdf \
 *     --title "Recursive Macroeconomic Theory" \
 *     --author "Ljungqvist & Sargent" \
 *     --field macro
 *
 * Pipeline:
 *   1. Extract text page-by-page from the PDF.
 *   2. Split into paragraphs, attaching page numbers.
 *   3. Detect chapter/section headers heuristically.
 *   4. Chunk paragraphs (lib/chunking.ts).
 *   5. Batch-embed (lib/embeddings.ts).
 *   6. Insert into Postgres.
 *
 * This is intentionally simple. Real production ingestion would:
 *   - Use Mathpix or Marker for math-aware PDF parsing
 *   - Hand-craft chapter detection per book series
 *   - OCR scanned pages with Tesseract
 *   - Deduplicate near-identical chunks
 *
 * For learning, the simple version is fine.
 */

import { readFileSync } from 'fs';
import { parseArgs } from 'util';
import pdfParse from 'pdf-parse';
import pgvector from 'pgvector/pg';
import { pool, ensurePgvector } from '../lib/db';
import { embedBatch } from '../lib/embeddings';
import { chunkParagraphs, type Paragraph } from '../lib/chunking';

const { values } = parseArgs({
  options: {
    pdf: { type: 'string' },
    title: { type: 'string' },
    author: { type: 'string' },
    field: { type: 'string' },
    description: { type: 'string' },
    persona: { type: 'string' },
  },
});

if (!values.pdf || !values.title || !values.author) {
  console.error('Usage: tsx scripts/ingest.ts --pdf <path> --title <title> --author <author> [--field macro|micro|...]');
  process.exit(1);
}

// Regex heuristics for chapter and section detection. Tune per book.
// Most modern textbooks use lines like "Chapter 4" or "4.2 Optimality".
const CHAPTER_RE = /^\s*(Chapter\s+\d+|CHAPTER\s+\d+|\d+\s+[A-Z][A-Za-z ]{4,80})\s*$/;
const SECTION_RE = /^\s*(\d+\.\d+(\.\d+)?)\s+([A-Z][^\n]{3,80})\s*$/;

async function extractParagraphs(pdfPath: string): Promise<Paragraph[]> {
  const buf = readFileSync(pdfPath);
  // pdf-parse gives us the full text but loses page boundaries by default.
  // We hook into its page callback to track pages.
  const pageBreaks: number[] = [];
  let cumChars = 0;
  const data = await pdfParse(buf, {
    pagerender: async (pageData: any) => {
      const text = await pageData.getTextContent().then((tc: any) =>
        tc.items.map((i: any) => i.str).join(' ')
      );
      cumChars += text.length;
      pageBreaks.push(cumChars);
      return text + '\n\f\n'; // form-feed marks page break
    },
  });

  // Split on form-feed to recover pages.
  const pages = data.text.split('\f');
  const paragraphs: Paragraph[] = [];
  let currentChapter: string | undefined;
  let currentSection: string | undefined;

  pages.forEach((pageText, idx) => {
    const pageNum = idx + 1;
    // Paragraphs are separated by blank lines in extracted text.
    const rawParas = pageText.split(/\n\s*\n/);
    for (const raw of rawParas) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text.length < 40) continue; // skip page numbers, headers, etc.

      const chapterMatch = text.match(CHAPTER_RE);
      if (chapterMatch) {
        currentChapter = chapterMatch[1].trim();
        currentSection = undefined;
        continue; // don't keep the header itself as a paragraph
      }
      const sectionMatch = text.match(SECTION_RE);
      if (sectionMatch) {
        currentSection = `${sectionMatch[1]} ${sectionMatch[3]}`.trim();
        continue;
      }

      paragraphs.push({
        text,
        chapter: currentChapter,
        section: currentSection,
        page: pageNum,
      });
    }
  });

  return paragraphs;
}

async function main() {
  await ensurePgvector();
  console.log(`Reading PDF: ${values.pdf}`);
  const paragraphs = await extractParagraphs(values.pdf!);
  console.log(`Extracted ${paragraphs.length} paragraphs`);

  const chunks = chunkParagraphs(paragraphs);
  console.log(`Built ${chunks.length} chunks (avg ${Math.round(chunks.reduce((s,c)=>s+c.content.length,0)/chunks.length)} chars)`);

  console.log('Embedding chunks (this may take a minute)...');
  const embeddings = await embedBatch(chunks.map(c => c.content));
  console.log(`Got ${embeddings.length} embeddings`);

  // Insert book row.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bookRes = await client.query(
      `INSERT INTO books (title, author, field, description, persona)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [values.title, values.author, values.field || null, values.description || null, values.persona || null]
    );
    const bookId = bookRes.rows[0].id;
    console.log(`Created book id=${bookId}`);

    // Insert chunks. Could use COPY for speed at scale; INSERT is fine here.
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await client.query(
        `INSERT INTO chunks (book_id, chapter, section, page, content, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [bookId, c.chapter || null, c.section || null, c.page || null, c.content, pgvector.toSql(embeddings[i])]
      );
      if ((i + 1) % 50 === 0) console.log(`  ${i+1}/${chunks.length} inserted`);
    }
    await client.query('COMMIT');
    console.log('Done.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
