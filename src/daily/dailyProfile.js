"use strict";

const { validateTeamProfileInput } = require("../domain/leagues/teamProfilePolicy");
const { teamPatternColourCount } = require("../domain/leagues/teamPatternPolicy");

function validateDailyAppearance(input) {
  try {
    if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "appearance")) throw new TypeError();
    if (input.appearance === null) return null;
    const appearance = input.appearance;
    const keys = ["patternTemplate", "primaryColour", "secondaryColour", "tertiaryColour"];
    if (!appearance || Array.isArray(appearance) || Object.keys(appearance).length !== keys.length ||
        !keys.every(key => Object.hasOwn(appearance, key))) throw new TypeError();
    const validated = validateTeamProfileInput(appearance);
    const count = teamPatternColourCount(validated.patternTemplate);
    if (!validated.colours?.primaryColour || !validated.colours?.secondaryColour ||
        (count === 3 && !validated.colours.tertiaryColour) || (count === 2 && validated.colours.tertiaryColour !== null)) throw new TypeError();
    return { patternTemplate: validated.patternTemplate, ...validated.colours };
  } catch {
    throw Object.assign(new Error("Choose a stripe template and all of its colours, or clear your stripes."),
      { status: 400, code: "DAILY_PROFILE_INVALID" });
  }
}

module.exports = { validateDailyAppearance };
