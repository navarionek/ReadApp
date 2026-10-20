-- 20261020170000_money_prize_participants.sql
-- Kto bierze udział w nagrodzie pieniężnej. Ustawia tylko admin, przez funkcję
-- (user nie ma UPDATE na tej kolumnie, więc sam sobie tego nie włączy).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS in_money_prize boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.set_money_prize(target uuid, participates boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Tylko admin może to zmienić' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles SET in_money_prize = participates WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nie ma takiego konta';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_money_prize(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_money_prize(uuid, boolean) TO authenticated;
