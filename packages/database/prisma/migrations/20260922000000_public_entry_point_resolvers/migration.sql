-- Public entry points under row-level security.
--
-- Four routes run with no signed-in user and therefore no tenant context:
-- payment webhooks, the public booking quote, and the local storage adapter's
-- upload/download. Under RLS (the API connects as lodgiva_app) every one of
-- them failed: webhook deliveries were refused on insert, and the other
-- lookups silently found nothing. Found on 2026-09-22, the first time the
-- integration suite ran against real PostgreSQL RLS.
--
-- The fix keeps isolation strict. Each resolver below answers exactly one
-- question - "which tenant owns this?" - with the definer's privileges, and
-- returns an answer ONLY when it is unambiguous. The API then sets that
-- tenant and does all real work under normal RLS. No owner credentials are
-- needed at runtime.
--
-- Additive only: no column, table or data is dropped.

-- 1. WebhookEvent is the platform's delivery inbox. A delivery belongs to no
--    tenant until it is matched (tenantId is nullable by design), and no
--    tenant-facing route reads this table. Keep it out of tenant RLS, as the
--    authentication tables already are.
DROP POLICY IF EXISTS tenant_isolation ON public."WebhookEvent";
ALTER TABLE public."WebhookEvent" DISABLE ROW LEVEL SECURITY;

-- 2. Which tenant owns a payment reference? References are unique per tenant,
--    not globally, so a reference claimed by two tenants resolves to NULL
--    rather than to whichever row comes first.
CREATE OR REPLACE FUNCTION public.lodgiva_tenant_for_payment_reference(p_reference text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(DISTINCT "tenantId") = 1 THEN min("tenantId") END
  FROM "PaymentIntent"
  WHERE reference = p_reference
$$;

-- 3. Which active property does a public booking slug name? Slugs are unique
--    per tenant only; two hotel companies may both have "ikeja". Returning
--    the first match could quote - and book - the wrong hotel, so an
--    ambiguous slug returns no row.
CREATE OR REPLACE FUNCTION public.lodgiva_active_property_by_slug(p_slug text)
RETURNS TABLE ("tenantId" text, "propertyId" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p."tenantId", p.id
  FROM "Property" p
  WHERE p.slug = p_slug
    AND p.status = 'ACTIVE'
    AND (SELECT count(*) FROM "Property" q WHERE q.slug = p_slug AND q.status = 'ACTIVE') = 1
$$;

-- 4. Which tenant owns a stored object? (bucket, objectKey) is globally unique.
CREATE OR REPLACE FUNCTION public.lodgiva_tenant_for_file_object(p_bucket text, p_object_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT "tenantId" FROM "FileObject" WHERE bucket = p_bucket AND "objectKey" = p_object_key
$$;

-- Only the application role may call them.
REVOKE ALL ON FUNCTION public.lodgiva_tenant_for_payment_reference(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lodgiva_active_property_by_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lodgiva_tenant_for_file_object(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lodgiva_tenant_for_payment_reference(text) TO lodgiva_app;
GRANT EXECUTE ON FUNCTION public.lodgiva_active_property_by_slug(text) TO lodgiva_app;
GRANT EXECUTE ON FUNCTION public.lodgiva_tenant_for_file_object(text, text) TO lodgiva_app;
