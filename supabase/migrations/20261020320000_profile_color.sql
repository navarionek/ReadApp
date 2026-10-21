-- 20261020320000_profile_color.sql
-- Własny kolor osoby (ranking, wykresy, wyścig). NULL = kolor automatyczny z palety.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_color_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_color_check CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$');

-- Polityka „Users rename only themselves” już ogranicza zmiany do własnego profilu
GRANT UPDATE (color) ON TABLE public.profiles TO authenticated;
