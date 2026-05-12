import { anthropic } from '@ai-sdk/anthropic';
import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { retrieve } from '@/lib/retrieval';
import { pool } from '@/lib/db';

// Tell Next.js this route runs on Node (we need pg, not Edge runtime).
export const runtime = 'nodejs';
// Allow up to 60s for slow generations.
export const maxDuration = 60;

type ChatRequest = {
  messages: UIMessage[];
  bookId: number;
};

export async function POST(req: Request) {
  const { messages, bookId }: ChatRequest = await req.json();

  // Get the user's latest message — that's what we retrieve against.
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const queryText = lastUser?.parts
    ?.filter((p: any) => p.type === 'text')
    .map((p: any) => p.text)
    .join(' ') ?? '';

  // Fetch book metadata (title, author, persona).
  const bookRes = await pool.query(
    'SELECT title, author, persona FROM books WHERE id = $1',
    [bookId]
  );
  if (bookRes.rows.length === 0) {
    return new Response('Book not found', { status: 404 });
  }
  const book = bookRes.rows[0];

  // Retrieve relevant chunks.
  const chunks = await retrieve(bookId, queryText, 8);

  // Format chunks for the prompt. We label each one so the model can
  // cite them by tag, and we include chapter/section/page metadata.
  const context = chunks
    .map((c, i) => {
      const loc = [c.chapter, c.section, c.page ? `p. ${c.page}` : null]
        .filter(Boolean)
        .join(', ');
      return `[Passage ${i + 1}${loc ? ` — ${loc}` : ''}]\n${c.content}`;
    })
    .join('\n\n---\n\n');

  // Persona defaults to something sensible if the book row didn't set one.
  const persona =
    book.persona ||
    `You are ${book.author}, author of "${book.title}". You answer the reader's questions in your own voice, drawing on your book.`;

  const system = `${persona}

You will be shown passages retrieved from your book that may be relevant to the reader's question. Use them as the primary source for your answer.

Rules:
- Stay faithful to the content of the passages. Do not invent results that aren't in your book.
- When you draw on a specific passage, cite it inline like (Ch. 4, §4.2, p. 87). Use the location information given with each passage.
- If the passages don't contain enough to answer, say so plainly and suggest where in the book the reader might look.
- Mathematical notation should be rendered in LaTeX between $ ... $ for inline or $$ ... $$ for display math.
- Speak naturally, the way an author would in office hours — not like a search engine.

Retrieved passages:

${context}`;

  // Stream the response back. The Vercel AI SDK handles the SSE
  // protocol and the frontend's useChat() hook knows how to consume it.
  const result = streamText({
    model: anthropic('claude-sonnet-4-5'),
    system,
    messages: convertToModelMessages(messages),
    temperature: 0.4, // a little creativity but mostly faithful
  });

  return result.toUIMessageStreamResponse();
}
