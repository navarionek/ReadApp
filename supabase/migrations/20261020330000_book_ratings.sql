-- 20261020330000_book_ratings.sql
-- Ocena przeczytanej książki: kciuk w górę (1) albo w dół (-1); NULL = bez oceny.
-- Zmieniać ocenę może tylko właściciel wpisu (polityka „Users update own reads” z edit_delete_reads).

ALTER TABLE public.reads ADD COLUMN IF NOT EXISTS rating smallint;

ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_rating_check;
ALTER TABLE public.reads ADD CONSTRAINT reads_rating_check CHECK (rating IS NULL OR rating IN (-1, 1));

GRANT UPDATE (rating) ON TABLE public.reads TO authenticated;
