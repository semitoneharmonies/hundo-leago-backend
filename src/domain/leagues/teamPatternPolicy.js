const TEAM_PATTERN_DEFINITIONS = Object.freeze({
  "even-two": 2,
  "even-three": 3,
  "wide-centre-stripe": 2,
  "thin-centre-stripe": 2,
  "triple-pinstripe": 2,
  "double-accent-bands": 2,
  "angular-peak": 2,
  "mirrored-centre-band": 3,
  "offset-outlined-stack": 3,
  "layered-six-band": 3,
  "alternating-ladder": 3,
  "double-hairline": 3,
  "double-light-top-accent": 3,
  "layered-monochrome": 3,
  "split-colour-block": 3,
  "two-tone-stack": 3,
  "outlined-block": 3,
  "layered-contrast": 3,
  "mirrored-seven-band": 3,
  "accent-line-band": 3,
  "outlined-centre": 3,
  "two-stage-contrast": 3,
  "layered-double-light": 3,
  tiger: 2,
  leopard: 3,
  cowhide: 2,
  camouflage: 3,
  "snake-scales": 3,
  honeycomb: 2,
  checkerboard: 2,
  argyle: 3,
  chevrons: 3,
  "ocean-waves": 3,
  "two-colour-gradient": 2,
  "three-colour-gradient": 3,
});

const DEFAULT_TWO_TEAM_PATTERN = "even-two";
const DEFAULT_THREE_TEAM_PATTERN = "even-three";

function isTeamPatternTemplate(value) {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TEAM_PATTERN_DEFINITIONS, value)
  );
}

function teamPatternColourCount(value) {
  return isTeamPatternTemplate(value)
    ? TEAM_PATTERN_DEFINITIONS[value]
    : null;
}

module.exports = {
  DEFAULT_THREE_TEAM_PATTERN,
  DEFAULT_TWO_TEAM_PATTERN,
  TEAM_PATTERN_DEFINITIONS,
  isTeamPatternTemplate,
  teamPatternColourCount,
};
