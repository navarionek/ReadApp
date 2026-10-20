-- 20261020290000_reading_queue.sql
-- „Do przeczytania”: kolejka książek, które ktoś chce przeczytać. Widzą ją wszyscy zalogowani
-- (można podejrzeć cudzą), zmieniać i usuwać może tylko właściciel. Z kolejki książkę przenosi się
-- do „Teraz czytam” jedną funkcją (start_from_queue), razem z okładką i autorem.

CREATE TABLE IF NOT EXISTS public.reading_queue (
  id serial PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  author text,
  cover_url text,
  published_year integer,
  info_url text,
  description text,
  info_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reading_queue_book_info_check CHECK (
    (cover_url IS NULL OR cover_url ~ '^https://(books\.google\.com|books\.googleusercontent\.com|covers\.openlibrary\.org)/'
      OR cover_url ~ '^https://ipqjdqvfyfgggykaazug\.supabase\.co/storage/v1/object/public/covers/')
    AND (info_url IS NULL OR info_url ~ '^https://(books\.google\.[a-z.]+|openlibrary\.org)/')
    AND (author IS NULL OR char_length(author) <= 200)
    AND (published_year IS NULL OR published_year BETWEEN 0 AND 2100)
    AND (description IS NULL OR char_length(description) <= 3000)
  )
);

CREATE INDEX IF NOT EXISTS reading_queue_user_id_idx ON public.reading_queue (user_id);

ALTER TABLE public.reading_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.reading_queue FROM public, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.reading_queue TO authenticated;
GRANT INSERT (title, author) ON TABLE public.reading_queue TO authenticated;
GRANT UPDATE (title, author, cover_url, published_year, info_url, description, info_checked_at)
  ON TABLE public.reading_queue TO authenticated;
GRANT USAGE ON SEQUENCE public.reading_queue_id_seq TO authenticated;

CREATE POLICY "Logged in users can see reading queue" ON public.reading_queue
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users add own queue items" ON public.reading_queue
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users update own queue items" ON public.reading_queue
  FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users delete own queue items" ON public.reading_queue
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- Zaczynam czytać książkę z kolejki: ląduje w „Teraz czytam” (z autorem i okładką), znika z kolejki.
-- Działa jako wołający, więc obowiązują te same uprawnienia i RLS co przy zwykłych zapytaniach.
CREATE OR REPLACE FUNCTION public.start_from_queue(p_id integer, p_started_at timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  q public.reading_queue%ROWTYPE;
  new_id integer;
BEGIN
  SELECT * INTO q FROM public.reading_queue
  WHERE id = p_id AND user_id = (SELECT auth.uid())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nie ma takiej książki w kolejce' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.reading_now (title, started_at, author)
  VALUES (q.title, p_started_at, q.author)
  RETURNING id INTO new_id;

  IF q.info_checked_at IS NOT NULL THEN
    UPDATE public.reading_now
    SET cover_url = q.cover_url, published_year = q.published_year,
        info_url = q.info_url, description = q.description, info_checked_at = q.info_checked_at
    WHERE id = new_id;
  END IF;

  DELETE FROM public.reading_queue WHERE id = q.id;
  RETURN new_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.start_from_queue(integer, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.start_from_queue(integer, timestamptz) TO authenticated;
