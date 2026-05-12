-- Enable the pgvector extension. This adds the `vector` column type
-- and similarity operators (<->, <#>, <=>) to Postgres.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per textbook in the library.
CREATE TABLE IF NOT EXISTS books (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL,
  field       TEXT,                       -- 'macro', 'micro', 'metrics', etc.
  description TEXT,
  persona     TEXT,                       -- System-prompt voice for this author
  created_at  TIMESTAMP DEFAULT NOW()
);

-- One row per chunk of text from a book. The `embedding` column is
-- a 1536-dim vector because that's what OpenAI's text-embedding-3-small
-- returns. If you switch to a different model, change this dimension.
CREATE TABLE IF NOT EXISTS chunks (
  id        SERIAL PRIMARY KEY,
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter   TEXT,
  section   TEXT,
  page      INTEGER,
  content   TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- HNSW (Hierarchical Navigable Small World) index for fast cosine
-- similarity search. This is the modern choice — way faster than IVFFlat
-- on large corpora and doesn't require training.
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- For filtering by book before similarity search.
CREATE INDEX IF NOT EXISTS chunks_book_idx ON chunks (book_id);
