-- 20261121130000_past_reads.sql
-- Historyczna półka: książki przeczytane, zanim było Czytanko. Osobna tabela, bo to sama ewidencja:
-- nie liczy się do punktów, rankingu, nagrody, odznak ani statystyk (te czytają tylko reads).
-- read_year = rok przeczytania; NULL = „dawno” (bez dokładnego roku). Widzą wszyscy zalogowani
-- (jak cudzą półkę), zmieniać i usuwać może tylko właściciel. Okładki uzupełnia fill-book-info.

CREATE TABLE IF NOT EXISTS public.past_reads (
  id serial PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  author text,
  read_year integer CHECK (read_year BETWEEN 1900 AND 2100),
  unfinished boolean NOT NULL DEFAULT false,
  cover_url text,
  published_year integer,
  page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 20000),
  info_url text,
  description text,
  info_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT past_reads_book_info_check CHECK (
    (cover_url IS NULL OR cover_url ~ '^https://(books\.google\.com|books\.googleusercontent\.com|covers\.openlibrary\.org)/'
      OR cover_url ~ '^https://ipqjdqvfyfgggykaazug\.supabase\.co/storage/v1/object/public/covers/')
    AND (info_url IS NULL OR info_url ~ '^https://(books\.google\.[a-z.]+|openlibrary\.org)/')
    AND (author IS NULL OR char_length(author) <= 200)
    AND (published_year IS NULL OR published_year BETWEEN 0 AND 2100)
    AND (description IS NULL OR char_length(description) <= 3000)
  )
);

CREATE INDEX IF NOT EXISTS past_reads_user_id_idx ON public.past_reads (user_id);

ALTER TABLE public.past_reads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.past_reads FROM public, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.past_reads TO authenticated;
GRANT INSERT (title, author, read_year, unfinished, cover_url, published_year, page_count, info_url, description, info_checked_at)
  ON TABLE public.past_reads TO authenticated;
GRANT UPDATE (title, author, read_year, unfinished, cover_url, published_year, page_count, info_url, description, info_checked_at)
  ON TABLE public.past_reads TO authenticated;
GRANT USAGE ON SEQUENCE public.past_reads_id_seq TO authenticated;

CREATE POLICY "Logged in users can see past reads" ON public.past_reads
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users add own past reads" ON public.past_reads
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users update own past reads" ON public.past_reads
  FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users delete own past reads" ON public.past_reads
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));
