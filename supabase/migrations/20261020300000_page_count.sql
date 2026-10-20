-- 20261020300000_page_count.sql
-- Liczba stron z baz książek (Google Books / Open Library) dla książek w „Teraz czytam” i „Do przeczytania”.
-- Służy tylko jako podpowiedź przy kończeniu książki; punkty liczą się z liczby stron wpisanej przez czytelnika.

ALTER TABLE public.reading_now ADD COLUMN IF NOT EXISTS page_count integer;
ALTER TABLE public.reading_queue ADD COLUMN IF NOT EXISTS page_count integer;

ALTER TABLE public.reading_now DROP CONSTRAINT IF EXISTS reading_now_page_count_check;
ALTER TABLE public.reading_now ADD CONSTRAINT reading_now_page_count_check CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 20000);
ALTER TABLE public.reading_queue DROP CONSTRAINT IF EXISTS reading_queue_page_count_check;
ALTER TABLE public.reading_queue ADD CONSTRAINT reading_queue_page_count_check CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 20000);

GRANT UPDATE (page_count) ON TABLE public.reading_now TO authenticated;
GRANT UPDATE (page_count) ON TABLE public.reading_queue TO authenticated;

-- Przeniesienie z kolejki zabiera też liczbę stron
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
    SET cover_url = q.cover_url, published_year = q.published_year, page_count = q.page_count,
        info_url = q.info_url, description = q.description, info_checked_at = q.info_checked_at
    WHERE id = new_id;
  END IF;

  DELETE FROM public.reading_queue WHERE id = q.id;
  RETURN new_id;
END;
$$;
