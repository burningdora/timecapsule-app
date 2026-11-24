-- Схема ЛР7 (часть 2)
alter table capsules add column if not exists opened_at timestamptz;

create table if not exists notifications (
  id            bigserial primary key,
  capsule_id    integer not null,
  user_id       integer not null,
  kind          varchar(16) not null,
  capsule_title varchar(200) not null,
  created_at    timestamptz not null default now(),
  unique (capsule_id, kind)
);

create index if not exists capsules_due_idx on capsules (open_at) where opened_at is null;

select column_name, data_type
  from information_schema.columns
 where table_name = 'notifications'
 order by ordinal_position;
