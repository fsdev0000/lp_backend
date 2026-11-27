-- Update articles_updated_at trigger function so translations updates and date restorations do not touch updated_at
CREATE OR REPLACE FUNCTION update_articles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  -- If caller explicitly updated updated_at (e.g. restoring updated_at = created_at)
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at AND NEW.updated_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- If translatable source fields have not changed (e.g. only translations modified), preserve existing updated_at
  IF OLD.title IS NOT DISTINCT FROM NEW.title AND
     OLD.content IS NOT DISTINCT FROM NEW.content AND
     OLD.excerpt IS NOT DISTINCT FROM NEW.excerpt AND
     OLD.meta_title IS NOT DISTINCT FROM NEW.meta_title AND
     OLD.meta_description IS NOT DISTINCT FROM NEW.meta_description AND
     OLD.publish_date IS NOT DISTINCT FROM NEW.publish_date AND
     OLD.pillar IS NOT DISTINCT FROM NEW.pillar THEN
    NEW.updated_at = OLD.updated_at;
    RETURN NEW;
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
