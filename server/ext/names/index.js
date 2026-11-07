// First, middle and last names, kept apart — the way the campaign's lists
// keep them (First Name · Surname). persons.name stays the whole name every
// screen reads and searches; first_name, middle_name and last_name sit
// beside it, and the database keeps them in step, whichever way a person is
// written (an import, Add a person, the website, the door, a merge):
//   any part given  → name is "first middle last", as given
//   only name given → split: the first word is the first name, the last
//                     word the last name (with a van, de, von… before it:
//                     "Jo Van Sample" → Jo · Van Sample), any words between
//                     the middle name ("Mary Anne Example" → Mary · Anne ·
//                     Example); one word is a first name
// A first name with a second word or an initial ("Mary Anne", "John A.")
// is offered as first + middle where a name is typed or imported
// (shared/names.js) — the database keeps whatever it is given.
// An organization (kind 'org') keeps its name whole, with no parts.
// People on file before this get theirs split once, the same way — before
// the trigger is made, so their names stay exactly as written.
export const sql = `
alter table persons add column if not exists first_name text;
alter table persons add column if not exists middle_name text;
alter table persons add column if not exists last_name text;

-- A whole name → {first, middle, last}.
create or replace function persons_split_name(raw text) returns text[] language plpgsql immutable as $$
declare
  words text[];
  n int;
  k int;
begin
  words := string_to_array(nullif(regexp_replace(trim(coalesce(raw, '')), '\\s+', ' ', 'g'), ''), ' ');
  n := coalesce(array_length(words, 1), 0);
  if n = 0 then return array[null, null, null]::text[]; end if;
  if n = 1 then return array[words[1], null, null]::text[]; end if;
  k := n;
  while k - 1 > 1 and lower(words[k - 1]) = any (array['van', 'von', 'de', 'da', 'das', 'dos', 'del', 'della', 'der', 'den', 'di', 'du', 'la', 'le', 'st', 'st.', 'ten', 'ter']) loop
    k := k - 1;
  end loop;
  return array[words[1], nullif(array_to_string(words[2:k - 1], ' '), ''), array_to_string(words[k:n], ' ')]::text[];
end $$;

create or replace function persons_names() returns trigger language plpgsql as $$
declare
  parts text[];
begin
  if new.kind = 'org' then
    new.first_name := null;
    new.middle_name := null;
    new.last_name := null;
    return new;
  end if;
  -- New, or just made a person again (an org had none): the parts given
  -- make the name; without them the name is split below.
  if tg_op = 'INSERT' or new.kind is distinct from old.kind then
    if coalesce(trim(new.first_name), '') <> '' or coalesce(trim(new.middle_name), '') <> '' or coalesce(trim(new.last_name), '') <> '' then
      new.first_name := nullif(trim(new.first_name), '');
      new.middle_name := nullif(trim(new.middle_name), '');
      new.last_name := nullif(trim(new.last_name), '');
      new.name := trim(concat_ws(' ', new.first_name, new.middle_name, new.last_name));
      return new;
    end if;
  elsif new.first_name is distinct from old.first_name or new.middle_name is distinct from old.middle_name
        or new.last_name is distinct from old.last_name then
    new.first_name := nullif(trim(new.first_name), '');
    new.middle_name := nullif(trim(new.middle_name), '');
    new.last_name := nullif(trim(new.last_name), '');
    if new.first_name is not null or new.middle_name is not null or new.last_name is not null then
      new.name := trim(concat_ws(' ', new.first_name, new.middle_name, new.last_name));
    end if;
    return new;
  elsif new.name is not distinct from old.name then
    return new;
  end if;
  -- The whole name only: split it.
  parts := persons_split_name(new.name);
  new.first_name := parts[1];
  new.middle_name := parts[2];
  new.last_name := parts[3];
  return new;
end $$;

drop trigger if exists persons_names on persons;

-- Once: people on file before first and last names were kept.
update persons set first_name = s[1], middle_name = s[2], last_name = s[3]
  from (select id as pid, persons_split_name(name) as s from persons
         where first_name is null and last_name is null and kind <> 'org' and coalesce(trim(name), '') <> '') x
 where persons.id = x.pid;

create trigger persons_names before insert or update on persons for each row execute function persons_names();
`;
