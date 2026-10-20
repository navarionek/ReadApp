-- 20261020270000_author_input.sql
-- Autor wpisywany ręcznie przy dodawaniu książki (do tej pory trafiał tu tylko z wyszukiwarki okładek).

GRANT INSERT (author) ON TABLE public.reads TO authenticated;
GRANT INSERT (author) ON TABLE public.reading_now TO authenticated;

-- Kończenie książki z „Teraz czytam”: autor z formularza (NULL = zostaje ten z „Teraz czytam”,
-- pusty tekst = usunięty)
DROP FUNCTION IF EXISTS public.finish_reading(integer, integer, numeric, boolean, text[]);

CREATE OR REPLACE FUNCTION public.finish_reading(
  p_reading_id integer,
  p_pages integer,
  p_multiplier numeric,
  p_unfinished boolean DEFAULT false,
  p_labels text[] DEFAULT NULL,
  p_author text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r public.reading_now%ROWTYPE;
  new_id integer;
  final_author text;
BEGIN
  SELECT * INTO r FROM public.reading_now
  WHERE id = p_reading_id AND user_id = (SELECT auth.uid())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nie ma takiej książki w „Teraz czytam”' USING ERRCODE = '42501';
  END IF;

  final_author := CASE WHEN p_author IS NULL THEN r.author ELSE nullif(btrim(p_author), '') END;

  INSERT INTO public.reads (title, pages, multiplier, multiplier_labels, unfinished, started_at, author)
  VALUES (r.title, p_pages, p_multiplier, p_labels, p_unfinished, r.started_at, final_author)
  RETURNING id INTO new_id;

  -- Okładka i reszta danych wybrane w trakcie czytania (autor jest już wpisany wyżej)
  IF r.info_checked_at IS NOT NULL THEN
    UPDATE public.reads
    SET cover_url = r.cover_url, published_year = r.published_year,
        info_url = r.info_url, description = r.description, info_checked_at = r.info_checked_at
    WHERE id = new_id;
  END IF;

  DELETE FROM public.reading_now WHERE id = r.id;
  RETURN new_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finish_reading(integer, integer, numeric, boolean, text[], text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.finish_reading(integer, integer, numeric, boolean, text[], text) TO authenticated;
