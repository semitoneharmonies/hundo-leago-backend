"use strict";

const CAP_SAVINGS_VERSION = "cap-savings-v1";
const CLASSIC_VERSION = "classic-v1";
const DAILY_CAP = 100;

function validateCapSavingsBonus(value) {
  if (value !== undefined && typeof value !== "boolean") {
    throw Object.assign(new Error("Choose whether to use the cap savings bonus."),
      { status: 400, code: "DAILY_CAP_BONUS_INVALID" });
  }
  return value;
}

function capBonusRatePercent(room) {
  return room.scoringVersion === CAP_SAVINGS_VERSION ? 0.25 : 0;
}

function dailyTeamScore(room, hockeyPointsHundredths, spent) {
  if (!Number.isSafeInteger(hockeyPointsHundredths) || !Number.isSafeInteger(spent) || spent < 0 || spent > DAILY_CAP) {
    throw new TypeError("Daily team score requires valid points and signed salary.");
  }
  const saved = DAILY_CAP - spent;
  const rate = capBonusRatePercent(room);
  // 0.25% is exactly 1/400. Round only the aggregate team bonus, half up to
  // one hundredth; never round each player's contribution separately.
  const bonusHundredths = rate && hockeyPointsHundredths > 0
    ? Number((BigInt(hockeyPointsHundredths) * BigInt(saved) + 200n) / 400n) : 0;
  const total = hockeyPointsHundredths + bonusHundredths;
  if (!Number.isSafeInteger(total)) throw new TypeError("Daily team score is outside the supported range.");
  return { hockeyPoints: hockeyPointsHundredths / 100, capBonusPercent: saved * rate,
    capBonusPoints: bonusHundredths / 100, points: total / 100 };
}

module.exports = { CAP_SAVINGS_VERSION, CLASSIC_VERSION, capBonusRatePercent, dailyTeamScore, validateCapSavingsBonus };
