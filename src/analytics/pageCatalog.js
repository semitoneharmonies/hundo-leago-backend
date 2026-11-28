"use strict";

// Keep the original catalog for older strict Admin clients. New page types fold into these groups.
const LEGACY_CATEGORIES = Object.freeze(Object.fromEntries(Object.entries({
  "leago": [
    "dashboard",
    "rosters",
    "players",
    "matchups",
    "standings",
    "auctions",
    "trades",
    "drafts",
    "activity",
    "commissioner",
    "teams"
  ],
  "daily": [
    "lobby",
    "room",
    "history",
    "profile",
    "notifications",
    "create",
    "practice"
  ],
  "shared": [
    "home",
    "account",
    "notifications",
    "install",
    "games",
    "leagues"
  ]
}).map(([product,categories]) => [product,Object.freeze(categories)])));
const REFINED_CATEGORY_PARENTS = Object.freeze(Object.fromEntries(Object.entries({
  "leago": {
    "team_roster": "rosters",
    "public_roster": "rosters",
    "players_list": "players",
    "player_detail": "players",
    "auctions_list": "auctions",
    "auction_detail": "auctions",
    "trades_list": "trades",
    "trade_detail": "trades",
    "drafts_free_agent": "drafts",
    "drafts_entry": "drafts",
    "draft_current": "drafts",
    "draft_room": "drafts",
    "draft_allocation_results": "drafts",
    "draft_results": "drafts",
    "draft_card": "drafts",
    "commissioner_overview": "commissioner",
    "commissioner_calendar": "commissioner",
    "commissioner_scoring": "commissioner",
    "commissioner_auctions": "commissioner",
    "commissioner_rosters": "commissioner",
    "commissioner_fad": "commissioner",
    "commissioner_communications": "commissioner",
    "commissioner_readiness": "commissioner",
    "commissioner_history": "commissioner",
    "commissioner_help": "commissioner",
    "commissioner_recovery": "commissioner",
    "commissioner_pause": "commissioner",
    "commissioner_season": "commissioner",
    "commissioner_export": "commissioner"
  },
  "daily": {},
  "shared": {
    "tip_jar": "games",
    "mr_boni": "games"
  }
}).map(([product,parents]) => [product,Object.freeze(parents)])));
const CATEGORIES = Object.freeze(Object.fromEntries(Object.entries(LEGACY_CATEGORIES).map(([product,categories]) => [product,Object.freeze([...categories,...Object.keys(REFINED_CATEGORY_PARENTS[product])])])));
function isRefinedCategory(product, category) { return Object.hasOwn(REFINED_CATEGORY_PARENTS[product] || {}, category); }
function legacyCategory(product, category) { return REFINED_CATEGORY_PARENTS[product]?.[category] || category; }
module.exports = { LEGACY_CATEGORIES, REFINED_CATEGORY_PARENTS, CATEGORIES, isRefinedCategory, legacyCategory };
