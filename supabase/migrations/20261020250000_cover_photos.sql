-- 20261020250000_cover_photos.sql
-- Własne zdjęcia okładek: publiczny bucket „covers”, do którego każdy zalogowany wgrywa pliki
-- tylko do własnego folderu (<user_id>/…). Adresy są nieodgadywalne (uuid), okładki nie są tajne.
-- Klient zmniejsza zdjęcie do JPEG, a bucket i tak pilnuje typu i rozmiaru.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('covers', 'covers', true, 1048576, ARRAY['image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE
SET public = true, file_size_limit = 1048576, allowed_mime_types = ARRAY['image/jpeg', 'image/webp'];

DROP POLICY IF EXISTS "Users upload own covers" ON storage.objects;
CREATE POLICY "Users upload own covers" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'covers' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "Users delete own covers" ON storage.objects;
CREATE POLICY "Users delete own covers" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'covers' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

-- Okładka może być też z naszego bucketa (oprócz Google Books i Open Library)
ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_book_info_check;
ALTER TABLE public.reads ADD CONSTRAINT reads_book_info_check CHECK (
  (cover_url IS NULL OR cover_url ~ '^https://(books\.google\.com|books\.googleusercontent\.com|covers\.openlibrary\.org)/'
    OR cover_url ~ '^https://ipqjdqvfyfgggykaazug\.supabase\.co/storage/v1/object/public/covers/')
  AND (info_url IS NULL OR info_url ~ '^https://(books\.google\.[a-z.]+|openlibrary\.org)/')
  AND (author IS NULL OR char_length(author) <= 200)
  AND (published_year IS NULL OR published_year BETWEEN 0 AND 2100)
  AND (description IS NULL OR char_length(description) <= 3000)
);

ALTER TABLE public.reading_now DROP CONSTRAINT IF EXISTS reading_now_book_info_check;
ALTER TABLE public.reading_now ADD CONSTRAINT reading_now_book_info_check CHECK (
  (cover_url IS NULL OR cover_url ~ '^https://(books\.google\.com|books\.googleusercontent\.com|covers\.openlibrary\.org)/'
    OR cover_url ~ '^https://ipqjdqvfyfgggykaazug\.supabase\.co/storage/v1/object/public/covers/')
  AND (info_url IS NULL OR info_url ~ '^https://(books\.google\.[a-z.]+|openlibrary\.org)/')
  AND (author IS NULL OR char_length(author) <= 200)
  AND (published_year IS NULL OR published_year BETWEEN 0 AND 2100)
  AND (description IS NULL OR char_length(description) <= 3000)
);
