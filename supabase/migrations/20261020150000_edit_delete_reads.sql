-- 20261020150000_edit_delete_reads.sql
-- Każdy może poprawić i usunąć swoje wpisy (tylko swoje).

GRANT UPDATE (title, pages, multiplier) ON TABLE public.reads TO authenticated;
GRANT DELETE ON TABLE public.reads TO authenticated;

CREATE POLICY "Users update own reads" ON public.reads
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users delete own reads" ON public.reads
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Mnożniki się mnożą: 0.5 (obrazkowa) x 1.5 (angielski) x 1.5 (naukowa)
ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_multiplier_check;
ALTER TABLE public.reads
  ADD CONSTRAINT reads_multiplier_check CHECK (multiplier IN (0.5, 0.75, 1, 1.125, 1.5, 2.25));
