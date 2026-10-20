export const SUPABASE_URL = 'https://ipqjdqvfyfgggykaazug.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_lYoZG-uKAFWKMzyu4YV45Q_64jU7CBW';

// Klient sam dokłada token zalogowanego usera do każdego zapytania
export const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
