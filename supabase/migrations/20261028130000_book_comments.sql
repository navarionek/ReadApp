-- 20261028130000_book_comments.sql
-- Komentarze pod przeczytanymi książkami (w oknie książki na Półce i w Rankingu). Widzą je wszyscy zalogowani,
-- dodać może każdy, usunąć autor komentarza albo właściciel książki. Komentarza nie da się edytować.
-- Komentarze znikają razem z książką.

CREATE TABLE IF NOT EXISTS public.book_comments (
  id bigserial PRIMARY KEY,
  read_id integer NOT NULL REFERENCES public.reads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS book_comments_read_id_idx ON public.book_comments (read_id, created_at);

ALTER TABLE public.book_comments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.book_comments FROM public, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.book_comments TO authenticated;
GRANT INSERT (read_id, body) ON TABLE public.book_comments TO authenticated;
GRANT USAGE ON SEQUENCE public.book_comments_id_seq TO authenticated;

CREATE POLICY "Logged in users can see comments" ON public.book_comments
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users add own comments" ON public.book_comments
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Authors and book owners delete comments" ON public.book_comments
  FOR DELETE TO authenticated USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM public.reads r WHERE r.id = read_id AND r.user_id = (SELECT auth.uid()))
  );
