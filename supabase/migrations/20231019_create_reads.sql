-- 20231019_create_reads.sql

-- Create reads table
CREATE TABLE IF NOT EXISTS reads (
  id serial PRIMARY KEY,
  username text NOT NULL,
  pages integer NOT NULL,
  multiplier numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Enable Row Level Security for reads
ALTER TABLE reads ENABLE ROW LEVEL SECURITY;

-- Policy: allow any authenticated user to insert
CREATE POLICY "Allow inserts" ON reads
  FOR INSERT TO public
  WITH CHECK (true);

-- Policy: allow any authenticated user to select
CREATE POLICY "Allow selects" ON reads
  FOR SELECT TO public
  USING (true);

-- Grant public SELECT and INSERT on reads
GRANT SELECT, INSERT ON TABLE reads TO public;

-- Ensure the table exists in the public schema
SET search_path TO public;

