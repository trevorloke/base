// A made-up voter file for the person search's speed checks
// (server/test/search-scale.test.js, scripts/bench-search.mjs). Names only,
// no real person: 90 first names × 130 surnames, about 5% with an accented
// letter, 3% a hyphenated surname, 2% a two- or three-word one (Van Der …,
// De La …), 1% a middle name; phones on 80%, example.org emails on a third,
// a five-digit house number on everyone.
// Skewed on purpose, as a stress test (not a claim about the real file):
// one surname (BIG) on 8%, a second (BIG2) on 6% and also the middle name
// of another 3%; house numbers start "14" one time in nine, "145" one in
// ninety.
export const BIG = 'Singh';
export const BIG2 = 'Kaur';
export const FIRSTS = [
  'Aarav', 'Abdul', 'Adam', 'Aiden', 'Aisha', 'Alex', 'Ali', 'Amanda', 'Amar', 'Amrit', 'Andrew', 'Angela', 'Anil', 'Anita', 'Anna', 'Arjun', 'Ava', 'Ben',
  'Carlos', 'Chen', 'Chloe', 'Chris', 'Daniel', 'David', 'Deepak', 'Diana', 'Elena', 'Emily', 'Emma', 'Eric', 'Ethan', 'Farah', 'Fatima', 'Grace', 'Gurpreet',
  'Hannah', 'Harjit', 'Harpreet', 'Hassan', 'Hui', 'Ian', 'Jacob', 'James', 'Jasmine', 'Jaspreet', 'Jason', 'Jennifer', 'Jessica', 'John', 'Karan', 'Karen',
  'Kevin', 'Kim', 'Laura', 'Liam', 'Linda', 'Lucas', 'Manpreet', 'Maria', 'Mark', 'Mary', 'Mei', 'Michael', 'Min', 'Mohammed', 'Navdeep', 'Noah', 'Olivia',
  'Omar', 'Paul', 'Priya', 'Raj', 'Ravi', 'Rebecca', 'Robert', 'Ryan', 'Sandeep', 'Sarah', 'Simran', 'Sophia', 'Steven', 'Sunil', 'Susan', 'Thomas', 'Tom',
  'Victoria', 'Wei', 'William', 'Yan', 'Zara',
];
export const ACCENTED = ['José', 'Zoë', 'Renée', 'François', 'Chloé', 'Inés', 'Søren', 'Björn', 'Thi', 'Đức'];
export const LASTS = [
  'Smith', 'Brown', 'Lee', 'Wong', 'Nguyen', 'Chan', 'Wilson', 'Taylor', 'Johnson', 'Martin', 'Anderson', 'Thompson', 'White', 'Gill', 'Sidhu', 'Sandhu',
  'Dhillon', 'Grewal', 'Brar', 'Sangha', 'Bains', 'Johal', 'Mann', 'Dhaliwal', 'Sharma', 'Patel', 'Kumar', 'Khan', 'Ali', 'Ahmed', 'Hussain', 'Chen', 'Li',
  'Wang', 'Zhang', 'Liu', 'Huang', 'Lin', 'Wu', 'Tran', 'Le', 'Pham', 'Kim', 'Park', 'Choi', 'Santos', 'Reyes', 'Cruz', 'Garcia', 'Lopez', 'Martinez', 'Rodriguez',
  'Hernandez', 'Gonzalez', 'Perez', 'Clark', 'Lewis', 'Walker', 'Hall', 'Allen', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson', 'Hill',
  'Campbell', 'Mitchell', 'Roberts', 'Carter', 'Phillips', 'Evans', 'Turner', 'Torres', 'Parker', 'Collins', 'Edwards', 'Stewart', 'Morris', 'Murphy', 'Cook',
  'Rogers', 'Morgan', 'Peterson', 'Cooper', 'Reed', 'Bailey', 'Bell', 'Gomez', 'Kelly', 'Howard', 'Ward', 'Cox', 'Diaz', 'Richardson', 'Wood', 'Watson',
  'Brooks', 'Bennett', 'Gray', 'James', 'Hughes', 'Price', 'Sanders', 'Myers', 'Long', 'Ross', 'Foster', 'Powell', 'Jenkins', 'Perry', 'Russell', 'Sullivan',
  'Fraser', 'MacDonald', 'Tremblay', 'Gagnon', 'Roy', 'Côté', 'Bouchard', 'Gauthier', 'Morin', 'Lavoie', 'Fortin', 'Gagné', 'Ouellet', 'Pelletier', 'Bélanger',
  'Lévesque', 'Bergeron',
].slice(0, 130);
const STREETS = ['72 Ave', '64 Ave', '88 Ave', '104 Ave', '152 St', '128 St', 'King George Blvd', 'Fraser Hwy'];

// n people into one campaign, in one statement (the names trigger fills
// the name from its parts).
export const fillPeople = async (db, ws, n) => {
  await db.query(
    `with g as (
       select g,
              abs(hashtext('a' || g)) as h1, abs(hashtext('b' || g)) as h2, abs(hashtext('c' || g)) as h3,
              abs(hashtext('d' || g)) as h4, abs(hashtext('e' || g)) as h5, abs(hashtext('f' || g)) as h6
         from generate_series(1, $2::int) g),
     n as (
       select g.*,
              case when h2 % 20 = 0 then ($5::text[])[1 + h2 / 20 % array_length($5::text[], 1)]
                   else ($3::text[])[1 + h2 % array_length($3::text[], 1)] end as first,
              case when h1 % 100 < 8 then $6
                   when h1 % 100 < 14 then $7
                   when h1 % 100 < 16 then (array['Van Der ', 'De La ', 'Van '])[1 + h1 / 100 % 3] || ($4::text[])[1 + h1 / 300 % 130]
                   when h1 % 100 < 19 then ($4::text[])[1 + h1 / 100 % 130] || '-' || ($4::text[])[1 + h1 / 13000 % 130]
                   else ($4::text[])[1 + h1 / 100 % 130] end as last,
              case when h3 % 100 < 3 then $7
                   when h3 % 100 = 3 then ($3::text[])[1 + h3 / 100 % array_length($3::text[], 1)] end as middle
         from g)
     insert into persons (id, workspace_id, first_name, middle_name, last_name, name, phone, email, address, house_number, city)
     select gen_random_uuid(), $1, first, case when middle = last then null else middle end, last, '',
            case when h4 % 10 < 8 then (array['604', '778', '236'])[1 + h4 / 10 % 3] || '-555-' || lpad((h4 / 30 % 10000)::text, 4, '0') end,
            case when h5 % 3 = 0 then lower(left(first, 1) || regexp_replace(last, '[^A-Za-z]', '', 'g')) || (g % 100) || '@example.org' end,
            (10 + h6 % 9)::text || (h6 / 9 % 10)::text || lpad((h6 / 90 % 100)::text, 2, '0') || ' ' || ($8::text[])[1 + h6 / 9000 % 8],
            (10 + h6 % 9)::text || (h6 / 9 % 10)::text || lpad((h6 / 90 % 100)::text, 2, '0'),
            'Surrey'
       from n`,
    [ws, n, FIRSTS, LASTS, ACCENTED, BIG, BIG2, STREETS],
  );
};
