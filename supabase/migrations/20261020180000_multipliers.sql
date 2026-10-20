-- 20261020180000_multipliers.sql
-- Mnożniki do wyboru w formularzu, zarządzane przez admina.
-- Wpis (reads.multiplier) trzyma iloczyn z chwili zapisu, więc zmiana lub usunięcie
-- mnożnika nie zmienia punktów za stare wpisy.

CREATE TABLE IF NOT EXISTS public.multipliers (
  id serial PRIMARY KEY,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 40),
  value numeric NOT NULL CHECK (value > 0 AND value <= 10)
);

INSERT INTO public.multipliers (label, value)
SELECT label, value FROM (VALUES ('Angielski', 1.5), ('Naukowa', 1.5), ('Obrazkowa', 0.5)) AS v(label, value)
WHERE NOT EXISTS (SELECT 1 FROM public.multipliers);

ALTER TABLE public.multipliers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.multipliers FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.multipliers TO authenticated;
GRANT USAGE ON SEQUENCE public.multipliers_id_seq TO authenticated;

CREATE POLICY "Logged in users can read multipliers" ON public.multipliers
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Admins insert multipliers" ON public.multipliers
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY "Admins update multipliers" ON public.multipliers
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY "Admins delete multipliers" ON public.multipliers
  FOR DELETE TO authenticated
  USING ((SELECT public.is_admin()));

-- Mnożnik wpisu to dowolny iloczyn wybranych mnożników, więc zamiast listy wartości tylko zakres
ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_multiplier_check;
ALTER TABLE public.reads
  ADD CONSTRAINT reads_multiplier_check CHECK (multiplier > 0 AND multiplier <= 100);
