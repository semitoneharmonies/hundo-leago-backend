// Match the established teamIdentity display defaults. These colours are a
// presentation fallback, never a replacement for stored team preferences.
function resolveTeamDisplayColours({ primaryColour, secondaryColour, tertiaryColour }) {
  if (primaryColour === null && secondaryColour === null && tertiaryColour === null) {
    return Object.freeze({ primaryColour: "#16324f", secondaryColour: "#f7f7f7", tertiaryColour: null });
  }
  return Object.freeze({ primaryColour, secondaryColour, tertiaryColour });
}

module.exports = { resolveTeamDisplayColours };
