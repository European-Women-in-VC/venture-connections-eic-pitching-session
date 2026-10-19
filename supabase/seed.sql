-- Speakers from Airtable "EIC - Speakers" (slugs = Webflow CMS slugs).
-- Safe to re-run: updates name/company on slug conflict, keeps capacity/availability edits.
insert into public.speakers (slug, name, company, capacity, availability) values
  ('alithea-biotechnology-gmbh',          'Fanny Giannou',         'Alithea Biotechnology GmbH',          4, 'open'),
  ('bamboo-energy',                       'Cristina Corchero',     'Bamboo Energy',                       4, 'open'),
  ('bitagreen',                           'Nora Van Cauwenbergh',  'Bitagreen',                           4, 'open'),
  ('cellugy',                             'Isabel Alvarez Martos', 'Cellugy',                             4, 'open'),
  ('ch-bioforce-oy',                      'Mari Taipale',          'CH-Bioforce Oy',                      4, 'open'),
  ('geniel-srl',                          'Cinzia Coppola',        'Geniel srl',                          4, 'open'),
  ('kedi-mobi-l-uygulama-anoni-m-i-rketi', 'Tuğba Önal Suzek',     'KEDİ MOBİL UYGULAMA ANONİM ŞİRKETİ',  4, 'open'),
  ('phosprint-s-a',                       'Ioanna Zergioti',       'PhosPrint S.A.',                      4, 'open'),
  ('proskope',                            'Meghan Perkins',        'Proskope',                            4, 'open'),
  ('quantonite',                          'Isabell Kunst',         'quantonite',                          4, 'open'),
  ('surphase',                            'Iliane Rafaniello',     'Surphase',                            4, 'open')
on conflict (slug) do update set name = excluded.name, company = excluded.company;
