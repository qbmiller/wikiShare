create table if not exists shares (
  id text primary key,
  token text not null unique,
  target_type text not null check (target_type in ('file', 'folder')),
  target_id text not null,
  expires_at integer not null,
  cancelled_at integer,
  created_by text not null references users(id),
  created_at integer not null
);

create index if not exists idx_shares_token on shares(token);
create index if not exists idx_shares_target on shares(target_type, target_id);
create index if not exists idx_shares_expires_at on shares(expires_at);
create index if not exists idx_shares_cancelled_at on shares(cancelled_at);
