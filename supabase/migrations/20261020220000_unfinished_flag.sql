-- 20261020220000_unfinished_flag.sql
-- Flaga „niedokończona” zamiast dopisku w tytule. Punkty liczą się normalnie (strony przeczytane).

ALTER TABLE public.reads ADD COLUMN IF NOT EXISTS unfinished boolean NOT NULL DEFAULT false;

GRANT INSERT (unfinished), UPDATE (unfinished) ON TABLE public.reads TO authenticated;

-- Dotychczasowe wpisy z dopiskiem w tytule: dopisek do flagi; okładka do ponownego wyszukania
UPDATE public.reads
SET unfinished = true,
    title = btrim(regexp_replace(title, '\s*\((niedoko[nń]czona)\)\s*', ' ', 'i')),
    info_checked_at = NULL
WHERE title ~* '\(niedoko[nń]czona\)';
