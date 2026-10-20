-- 20261020310000_edit_read_date.sql
-- Data skończenia książki (created_at) może być poprawiona przez właściciela wpisu (polityka
-- „Users update own reads” już ogranicza zmiany do własnych wpisów). Pilnujemy, żeby data
-- nie była z przyszłości ani z absurdalnej przeszłości; zgodność z datą rozpoczęcia
-- (started_at <= created_at) już wymusza reads_started_check.

GRANT UPDATE (created_at) ON TABLE public.reads TO authenticated;

ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_created_range_check;
ALTER TABLE public.reads ADD CONSTRAINT reads_created_range_check
  CHECK (created_at >= timestamptz '2000-01-01' AND created_at <= now() + interval '1 day');
