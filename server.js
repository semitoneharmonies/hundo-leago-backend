// server.js
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// --- In-memory league state (temporary until database) ---
let leagueState = {
  teams: [],
  freeAgents: [],
  tradeProposals: [],
  leagueLog: [],
};

// --- GET full league state ---
app.get("/state", (req, res) => {
  res.json(leagueState);
});

// --- POST replace league state (when React pushes changes) ---
app.post("/state", (req, res) => {
  leagueState = req.body;
  console.log("State updated:", new Date().toLocaleTimeString());
  res.json({ success: true });
});

// --- Simple test route ---
app.get("/", (req, res) => {
  res.send("Hundo Leago Backend is running!");
});

// --- Start server ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Hundo Leago backend listening on port ${PORT}`);
});
