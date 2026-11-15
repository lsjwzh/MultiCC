'use strict';

const catalog = require('./catalog');
const { createEventHub } = require('./hub');
const { createEventRuleEngine } = require('./engine');
const rules = require('./rules');

module.exports = { ...catalog, createEventHub, createEventRuleEngine, validateEventRule: rules.validateEventRule };
