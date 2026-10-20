-- 20261020260000_multiplier_labels.sql
-- Które mnożniki zaznaczono przy wpisie (nazwy z chwili zapisu). Sam iloczyn nie wystarcza do
-- odznak „Anglofil” i „Naukowiec”, bo np. 1,5x to „Angielski” albo „Naukowa”.
-- NULL = nie wiadomo (stare wpisy, których iloczyn da się złożyć na kilka sposobów).

ALTER TABLE public.reads ADD COLUMN IF NOT EXISTS multiplier_labels text[];

ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_multiplier_labels_check;
ALTER TABLE public.reads ADD CONSTRAINT reads_multiplier_labels_check CHECK (
  multiplier_labels IS NULL
  OR (cardinality(multiplier_labels) <= 10 AND char_length(array_to_string(multiplier_labels, '|')) <= 400)
);

GRANT INSERT (multiplier_labels), UPDATE (multiplier_labels) ON TABLE public.reads TO authenticated;

-- Jednoznaczne stare wpisy (przy domyślnych mnożnikach 0,5 / 1,5 / 1,5)
UPDATE public.reads
SET multiplier_labels = CASE multiplier
  WHEN 1 THEN ARRAY[]::text[]
  WHEN 0.5 THEN ARRAY['Obrazkowa']
  WHEN 2.25 THEN ARRAY['Angielski', 'Naukowa']
  WHEN 1.125 THEN ARRAY['Obrazkowa', 'Angielski', 'Naukowa']
END
WHERE multiplier_labels IS NULL AND multiplier IN (1, 0.5, 2.25, 1.125);

-- Kończenie książki z „Teraz czytam” zapisuje też nazwy mnożników
DROP FUNCTION IF EXISTS public.finish_reading(integer, integer, numeric, boolean);

CREATE OR REPLACE FUNCTION public.finish_reading(
  p_reading_id integer,
  p_pages integer,
  p_multiplier numeric,
  p_unfinished boolean DEFAULT false,
  p_labels text[] DEFAULT NULL
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

  INSERT INTO public.reads (title, pages, multiplier, multiplier_labels, unfinished, started_at)
  VALUES (r.title, p_pages, p_multiplier, p_labels, p_unfinished, r.started_at)
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

REVOKE EXECUTE ON FUNCTION public.finish_reading(integer, integer, numeric, boolean, text[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.finish_reading(integer, integer, numeric, boolean, text[]) TO authenticated;
