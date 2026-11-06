// First and last names, kept apart — the way the campaign's lists keep
// them (First Name · Surname). persons.name stays the whole name every
// screen reads and searches; first_name and last_name sit beside it, and
// the database keeps the three in step, whichever way a person is written
// (an import, Add a person, the website, the door, a merge):
//   first or last given → name is "first last"
//   only name given     → split: the last word is the last name, the rest
//                         the first ("Mary Anne Example" → Mary Anne ·
//                         Example; one word is a first name)
// An organization (kind 'org') keeps its name whole, with no first or last.
// People on file before this get theirs split once, the same way.
export const sql = `
alter table persons add column if not exists first_name text;
alter table persons add column if not exists last_name text;

create or replace function persons_names() returns trigger language plpgsql as $$
declare
  whole text;
  cut int;
begin
  if new.kind = 'org' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(trim(new.first_name), '') <> '' or coalesce(trim(new.last_name), '') <> '' then
      new.first_name := nullif(trim(new.first_name), '');
      new.last_name := nullif(trim(new.last_name), '');
      new.name := trim(concat_ws(' ', new.first_name, new.last_name));
      return new;
    end if;
  elsif new.first_name is distinct from old.first_name or new.last_name is distinct from old.last_name then
    new.first_name := nullif(trim(new.first_name), '');
    new.last_name := nullif(trim(new.last_name), '');
    if new.first_name is not null or new.last_name is not null then
      new.name := trim(concat_ws(' ', new.first_name, new.last_name));
    end if;
    return new;
  elsif new.name is not distinct from old.name then
    return new;
  end if;
  -- The whole name only: split it at the last space.
  whole := regexp_replace(trim(new.name), '\\s+', ' ', 'g');
  cut := length(whole) - length(regexp_replace(whole, '^.* ', ''));
  if cut > 0 then
    new.first_name := left(whole, cut - 1);
    new.last_name := substr(whole, cut + 1);
  else
    new.first_name := nullif(whole, '');
    new.last_name := null;
  end if;
  return new;
end $$;

drop trigger if exists persons_names on persons;
create trigger persons_names before insert or update on persons for each row execute function persons_names();

-- Once: people on file before first and last names were kept.
update persons
   set first_name = case when position(' ' in regexp_replace(trim(name), '\\s+', ' ', 'g')) > 0
                         then regexp_replace(regexp_replace(trim(name), '\\s+', ' ', 'g'), ' [^ ]*$', '')
                         else nullif(trim(name), '') end,
       last_name = case when position(' ' in regexp_replace(trim(name), '\\s+', ' ', 'g')) > 0
                        then regexp_replace(regexp_replace(trim(name), '\\s+', ' ', 'g'), '^.* ', '')
                        else null end
 where first_name is null and last_name is null and kind <> 'org' and coalesce(trim(name), '') <> '';
`;
