-- Add the selected team stripe or decorative pattern template.
-- Existing teams retain their current even two- or three-stripe appearance.

ALTER TABLE teams
  ADD COLUMN pattern_template TEXT NOT NULL DEFAULT 'even-two'
  CHECK (
    pattern_template IN (
      'even-two',
      'even-three',
      'wide-centre-stripe',
      'thin-centre-stripe',
      'triple-pinstripe',
      'double-accent-bands',
      'angular-peak',
      'mirrored-centre-band',
      'offset-outlined-stack',
      'layered-six-band',
      'alternating-ladder',
      'double-hairline',
      'double-light-top-accent',
      'layered-monochrome',
      'split-colour-block',
      'two-tone-stack',
      'outlined-block',
      'layered-contrast',
      'mirrored-seven-band',
      'accent-line-band',
      'outlined-centre',
      'two-stage-contrast',
      'layered-double-light',
      'tiger',
      'leopard',
      'cowhide',
      'camouflage',
      'snake-scales',
      'honeycomb',
      'checkerboard',
      'argyle',
      'chevrons',
      'ocean-waves',
      'two-colour-gradient',
      'three-colour-gradient'
    )
  );

UPDATE teams
SET pattern_template = 'even-three'
WHERE tertiary_colour IS NOT NULL;

UPDATE application_metadata
SET metadata_value = '22',
    updated_at_ms = CASE WHEN updated_at_ms < 1 THEN 1 ELSE updated_at_ms END
WHERE metadata_key = 'data_model_version';
