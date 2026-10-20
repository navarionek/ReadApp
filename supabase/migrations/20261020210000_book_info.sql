-- 20261020210000_book_info.sql
-- Okładka i informacje o książce (z Google Books / Open Library) zapisane przy wpisie.
-- Uzupełnia je właściciel wpisu (automatycznie albo wybierając okładkę ręcznie).

ALTER TABLE public.reads
  ADD COLUMN IF NOT EXISTS cover_url text,
  ADD COLUMN IF NOT EXISTS author text,
  ADD COLUMN IF NOT EXISTS published_year integer,
  ADD COLUMN IF NOT EXISTS info_url text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS info_checked_at timestamptz;

-- Okładki tylko z zaufanych serwisów, linki tylko https
ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_book_info_check;
ALTER TABLE public.reads ADD CONSTRAINT reads_book_info_check CHECK (
  (cover_url IS NULL OR cover_url ~ '^https://(books\.google\.com|books\.googleusercontent\.com|covers\.openlibrary\.org)/')
  AND (info_url IS NULL OR info_url ~ '^https://(books\.google\.[a-z.]+|openlibrary\.org)/')
  AND (author IS NULL OR char_length(author) <= 200)
  AND (published_year IS NULL OR published_year BETWEEN 0 AND 2100)
  AND (description IS NULL OR char_length(description) <= 3000)
);

-- Polityka „Users update own reads” już ogranicza zmiany do własnych wpisów
GRANT UPDATE (cover_url, author, published_year, info_url, description, info_checked_at)
  ON TABLE public.reads TO authenticated;
