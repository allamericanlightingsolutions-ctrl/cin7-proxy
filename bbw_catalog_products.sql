create table public.bbw_catalog_products (
  sku text primary key check (char_length(sku) between 1 and 80 and sku = upper(btrim(sku))),
  product jsonb not null check (jsonb_typeof(product) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.bbw_catalog_products enable row level security;
revoke all on table public.bbw_catalog_products from public, anon, authenticated;
grant select, insert, update on table public.bbw_catalog_products to service_role;
