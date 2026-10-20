-- 20261020200000_reading_now.sql
-- „Teraz czytam”: zaczęte książki. Po skończeniu klient dodaje zwykły wpis do reads
-- z started_at i usuwa pozycję stąd.

CREATE TABLE IF NOT EXISTS public.reading_now (
  id serial PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  started_at timestamptz NOT NULL DEFAULT now() CHECK (started_at <= now() + interval '1 day'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reading_now_user_id_idx ON public.reading_now (user_id);

ALTER TABLE public.reading_now ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.reading_now FROM public, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.reading_now TO authenticated;
GRANT INSERT (title, started_at), UPDATE (title, started_at) ON TABLE public.reading_now TO authenticated;
GRANT USAGE ON SEQUENCE public.reading_now_id_seq TO authenticated;

-- Wszyscy zalogowani widzą, kto co czyta; zmieniać można tylko swoje
CREATE POLICY "Logged in users can see reading now" ON public.reading_now
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users add own reading now" ON public.reading_now
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users update own reading now" ON public.reading_now
  FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users delete own reading now" ON public.reading_now
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- Wpis może mieć datę rozpoczęcia (wykresy rozkładają wtedy punkty od startu do końca)
ALTER TABLE public.reads ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_started_check;
ALTER TABLE public.reads
  ADD CONSTRAINT reads_started_check CHECK (started_at IS NULL OR started_at <= created_at);

GRANT INSERT (started_at) ON TABLE public.reads TO authenticated;
