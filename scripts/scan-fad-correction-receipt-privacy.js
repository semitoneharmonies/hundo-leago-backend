#!/usr/bin/env node

"use strict";

const scanner = require("./scan-fad-public-receipts");

if (require.main === module) scanner.main();

module.exports = scanner;
