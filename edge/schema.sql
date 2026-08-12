-- Yellide contribution store.
--
-- One row per install that has explicitly opted in. There is deliberately no column for an
-- IP address, hostname, operating system, locale, timezone, path, filename, drive label,
-- caption or search term, and the Worker rejects any field that is not listed here.
--
-- The key is hash(install_id + a server-side pepper). The install_id is a random value
-- generated on the user's machine and never stored here; without the pepper the key cannot
-- be recomputed from it, and the pepper never leaves the Worker's secret store.
--
-- Dates are months, not timestamps. A month is enough to say "still in use" and too coarse
-- to place anyone at a moment.

create table if not exists install (
  id_hash          text primary key,      -- hash(install_id + pepper). Not reversible.
  first_month      text not null,          -- '2026-08'
  last_month       text not null,          -- '2026-08'
  version          text not null,          -- Yellide's version, not the machine's

  images           integer not null default 0,
  video            integer not null default 0,
  audio            integer not null default 0,
  files_total      integer not null default 0,

  coverage_first   integer not null default 0,   -- percent, at first contribution
  coverage_latest  integer not null default 0,   -- percent, now
  captions         integer not null default 0
);

create index if not exists install_last_month on install(last_month);

-- The only thing the website reads. No row is ever exposed individually.
create view if not exists totals as
select
  count(*)                                              as installs,
  coalesce(sum(files_total), 0)                         as files,
  coalesce(sum(images), 0)                              as images,
  coalesce(sum(video), 0)                               as video,
  coalesce(sum(audio), 0)                               as audio,
  coalesce(sum(captions), 0)                            as captions,
  coalesce(round(avg(coverage_latest)), 0)              as coverage_now,
  coalesce(round(avg(coverage_first)), 0)               as coverage_at_first,
  coalesce(sum(case when coverage_latest > coverage_first then 1 else 0 end), 0) as improved
from install;
