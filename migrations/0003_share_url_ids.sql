alter table shares add column url_id text;

create unique index if not exists idx_shares_url_id on shares(url_id)
where url_id is not null;
