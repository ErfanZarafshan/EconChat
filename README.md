# Econ Chat — chat with advanced economics textbooks

A learning-oriented clone of hamkhan.ai for economics: each book in the library
becomes its own AI chatbot grounded in the book's text, speaking in the
author's voice.

This is your starter codebase. It works, but it's small enough to read and
modify in an afternoon.

## What it does

1. You drop a PDF of a textbook (Mas-Colell, Ljungqvist-Sargent, Acemoglu, etc.)
   into the `books/` folder.
2. Run the ingestion script. It extracts text, splits it into chunks, embeds
   each chunk as a 1536-dim vector, and stores the chunks + vectors in Postgres.
3. Start the web app. Each book gets its own chat page. When you ask a question,
   the app retrieves the most relevant passages from that book and sends them
   to Claude with a prompt that tells it to answer as the author, citing
   passages by chapter and page.

There is no fine-tuning. The "knowledge" is the retrieved text. The "persona"
is one system prompt. That's the whole trick.

## Architecture

```
PDF ─┬─> extract paragraphs ──> chunk (~1200 tokens, overlapping)
     │                                │
     │                                ▼
     │                          embed each chunk (OpenAI)
     │                                │
     │                                ▼
     └────────────────────────> Postgres (pgvector HNSW index)

User question
     │
     ▼
embed query ──> top-k cosine search filtered to one book
     │                                │
     │                                ▼
     │                       retrieved chunks + metadata
     │                                │
     └─────> Claude ◄──── system prompt: persona + chunks + cite rules
                │
                ▼
        streamed answer with citations and LaTeX math
```

## File tour

| File | What it does |
|---|---|
| `db/schema.sql` | Postgres schema with `books`, `chunks`, HNSW vector index |
| `lib/db.ts` | pg connection pool, pgvector type registration |
| `lib/embeddings.ts` | OpenAI embedding wrapper (single + batch) |
| `lib/chunking.ts` | Paragraph-aware chunking with overlap |
| `lib/retrieval.ts` | Embed query, cosine search, return top-k |
| `scripts/ingest.ts` | CLI: PDF → chunks → embeddings → DB |
| `app/api/chat/route.ts` | Streaming chat endpoint (the heart of the app) |
| `app/page.tsx` | Library home (server component) |
| `app/books/[id]/page.tsx` | Per-book chat page |
| `components/ChatInterface.tsx` | Client-side chat UI with KaTeX math rendering |

## Setup

Prerequisites: Node 20+, Docker, an OpenAI API key, an Anthropic API key.

```bash
# 1. Install deps
npm install

# 2. Start Postgres with pgvector
docker compose up -d

# 3. Configure environment
cp .env.example .env.local
# Edit .env.local with your API keys

# 4. Create tables
npm run db:init

# 5. Drop a PDF into ./books and ingest it
mkdir -p books
# (put your PDF here, e.g. books/ljungqvist-sargent.pdf)
npm run ingest -- \
  --pdf ./books/ljungqvist-sargent.pdf \
  --title "Recursive Macroeconomic Theory" \
  --author "Lars Ljungqvist and Thomas Sargent" \
  --field macro \
  --description "Standard graduate macro reference."

# 6. Run the app
npm run dev
# Open http://localhost:3000
```

## Cost estimate

Embedding a 1000-page textbook (~500K tokens) with `text-embedding-3-small`:
about $0.01. One-time cost per book.

Each chat turn: ~8 chunks × ~1000 tokens of context + response. With Claude
Sonnet, expect ~$0.02-0.05 per turn.

## Where to take it next

**Improvements to retrieval quality:**
- Hybrid search: combine vector similarity with BM25 keyword matching. pgvector
  + Postgres full-text search makes this easy. Helps a lot when the user asks
  for something with a specific named theorem.
- Reranking: take top-30 from vector search, rerank with a cross-encoder
  (Cohere Rerank, Voyage Rerank) down to top-8. Big win for ~$0.001 per query.
- Query expansion: ask the LLM to rewrite the user's question into 2-3
  alternative phrasings, run all of them, merge results.

**Better PDF parsing:**
- The current `pdf-parse` approach mangles equations in many books. For serious
  math content, swap in Mathpix Markdown or Marker (https://github.com/VikParuchuri/marker)
  which produce clean LaTeX from PDFs.
- For scanned older books, OCR with Tesseract or a vision LLM.

**Features:**
- Per-passage citations that link back to the PDF viewer at the right page.
- Conversation history persisted per user (add a `conversations` table).
- Discussion forum per book (separate `threads` and `posts` tables anchored
  to `book_id`).
- A "compare across books" mode: retrieve from multiple books and have Claude
  synthesize how Ljungqvist-Sargent and Stokey-Lucas differ on, say, dynamic
  programming proofs.

**Operational:**
- Move from `pdf-parse` to a background job queue for ingestion (BullMQ).
- Add caching of embeddings for repeated queries (Redis).
- Rate-limit the chat endpoint per user.

## Legal note

Ingesting copyrighted textbooks is fine for personal use and study, but you
can't run a public site that lets others chat with copyrighted material
without permission from the publisher. If you're building this for your
own learning, you're fine. If you want to make it public, start with public
domain or open-licensed texts (Acemoglu's lecture notes, NBER working papers,
old classics like Marshall, Mill, Smith on Project Gutenberg).
