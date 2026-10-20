-- 20261020240000_finish_reading.sql
-- Skończenie książki z „Teraz czytam” w jednej transakcji: wpis do reads (z datą rozpoczęcia i
-- okładką wybraną w trakcie czytania) + usunięcie z reading_now. Wcześniej robił to klient trzema
-- osobnymi zapytaniami, więc błąd po drodze zostawiał książkę i w rankingu, i w „Teraz czytam”.
--
-- Funkcja działa jako wołający (SECURITY INVOKER), więc obowiązują te same uprawnienia i RLS
-- co przy zwykłych zapytaniach: cudzej książki nie da się skończyć.

CREATE OR REPLACE FUNCTION public.finish_reading(
  p_reading_id integer,
  p_pages integer,
  p_multiplier numeric,
  p_unfinished boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r public.reading_now%ROWTYPE;
  new_id integer;
BEGIN
  SELECT * INTO r FROM public.reading_now
  WHERE id = p_reading_id AND user_id = (SELECT auth.uid())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nie ma takiej książki w „Teraz czytam”' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.reads (title, pages, multiplier, unfinished, started_at)
  VALUES (r.title, p_pages, p_multiplier, p_unfinished, r.started_at)
  RETURNING id INTO new_id;

  IF r.info_checked_at IS NOT NULL THEN
    UPDATE public.reads
    SET cover_url = r.cover_url, author = r.author, published_year = r.published_year,
        info_url = r.info_url, description = r.description, info_checked_at = r.info_checked_at
    WHERE id = new_id;
  END IF;

  DELETE FROM public.reading_now WHERE id = r.id;
  RETURN new_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finish_reading(integer, integer, numeric, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.finish_reading(integer, integer, numeric, boolean) TO authenticated;
