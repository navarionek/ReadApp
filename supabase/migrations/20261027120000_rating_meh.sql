-- 20261027120000_rating_meh.sql
-- Środkowa ocena książki „Takie se” (0) obok fajnej (1) i słabej (-1)

ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_rating_check;
ALTER TABLE public.reads ADD CONSTRAINT reads_rating_check CHECK (rating IS NULL OR rating IN (-1, 0, 1));
