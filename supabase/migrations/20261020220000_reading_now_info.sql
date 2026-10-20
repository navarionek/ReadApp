-- 20261020220000_reading_now_info.sql
-- Dodaje informacje o książce do „Teraz czytam”, aby umożliwić wybór okładki przed zakończeniem.

ALTER TABLE public.reading_now
  ADD COLUMN IF NOT EXISTS cover_url text,
  ADD COLUMN IF NOT EXISTS author text,
  ADD COLUMN IF NOT EXISTS published_year integer,
  ADD COLUMN IF NOT EXISTS info_url text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS info_checked_at timestamptz;

-- Spójność danych: okładki tylko z zaufanych serwisów, linki tylko https
ALTER TABLE public.reading_now DROP CONSTRAINT IF EXISTS reading_now_book_info_check;
ALTER TABLE public.reading_now ADD CONSTRAINT reading_now_book_info_check CHECK (
  (cover_url IS NULL OR cover_url ~ '^https://(books\.google\.com|books\.googleusercontent\.com|covers\.openlibrary\.org)/')
  AND (info_url IS NULL OR info_url ~ '^https://(books\.google\.[a-z.]+|openlibrary\.org)/')
  AND (author IS NULL OR char_length(author) <= 200)
  AND (published_year IS NULL OR published_year BETWEEN 0 AND 2100)
  AND (description IS NULL OR char_length(description) <= 3000)
);

-- Rozszerzenie uprawnień UPDATE
ALTER TABLE public.reading_now DROP CONSTRAINT IF EXISTS reading_now_update_policy; -- (if it exists, but it's a policy, not a constraint)
-- Actually policies are different. Let's just check the existing policy.
-- The existing policy is:
-- CREATE POLICY "Users update own reading now" ON public.reading_now
--   FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
-- This policy doesn't restrict columns, but the GRANT does.

-- We need to update the GRANT statement if it was specific.
-- The original migration:
-- GRANT INSERT (title, started_at), UPDATE (title, started_at) ON TABLE public.reading_now TO authenticated;

-- We need to update this to include the new columns.
-- Since we can't "update" a GRANT easily without dropping/recreating or just granting more,
-- we'll drop and re-grant the specific columns.
-- Actually, we can just GRANT the new columns.

GRANT UPDATE (cover_url, author, published_year, info_url, description, info_checked_at)
  ON TABLE public.reading_now TO authenticated;
