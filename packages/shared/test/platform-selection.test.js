'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
	initialPlatformSelection,
	reconcilePlatformSelection,
	togglePlatformSelection,
} = require('../dist/utils/platform-selection.js');

const availability = [
	{ id: 'win32', status: 'connected', agents: [] },
	{ id: 'darwin', status: 'offline', agents: [] },
	{ id: 'ps5', status: 'never-seen', agents: [] },
];
const supported = ['win32', 'darwin', 'ps5'];

test('defaults select every supported platform some agent has serviced', () => {
	const state = initialPlatformSelection({ configurationId: 'c1', supported, availability });
	assert.deepEqual(state.selected, ['win32', 'darwin']);
	assert.equal(state.initializedWithAvailability, true);
});

test('availability arriving after an all-platform default narrows the selection', () => {
	let state = initialPlatformSelection({ configurationId: 'c1', supported, availability: undefined });
	assert.deepEqual(state.selected, supported);
	state = reconcilePlatformSelection(state, { configurationId: 'c1', supported, availability });
	assert.deepEqual(state.selected, ['win32', 'darwin']);
});

test('deselecting macOS survives an availability refresh (regression)', () => {
	let state = initialPlatformSelection({ configurationId: 'c1', supported, availability });
	state = togglePlatformSelection(state, 'darwin', false);
	assert.deepEqual(state.selected, ['win32']);

	// The platforms query refetches periodically and hands back a new array instance.
	const refreshed = availability.map(a => ({ ...a }));
	state = reconcilePlatformSelection(state, { configurationId: 'c1', supported, availability: refreshed });
	assert.deepEqual(state.selected, ['win32']);

	// Even a freshly seen platform is not added behind the user's back.
	const ps5Seen = refreshed.map(a => (a.id === 'ps5' ? { ...a, status: 'connected' } : a));
	state = reconcilePlatformSelection(state, { configurationId: 'c1', supported, availability: ps5Seen });
	assert.deepEqual(state.selected, ['win32']);
});

test('switching configuration recomputes defaults and drops unsupported picks', () => {
	let state = initialPlatformSelection({ configurationId: 'c1', supported, availability });
	state = togglePlatformSelection(state, 'darwin', false);
	state = reconcilePlatformSelection(state, { configurationId: 'c2', supported: ['darwin'], availability });
	assert.equal(state.configurationId, 'c2');
	assert.equal(state.userEdited, false);
	assert.deepEqual(state.selected, ['darwin']);
});

test('a configuration that stops supporting a selected platform strips it and reports it', () => {
	let state = initialPlatformSelection({ configurationId: 'c1', supported, availability });
	state = togglePlatformSelection(state, 'ps5', true);
	state = reconcilePlatformSelection(state, { configurationId: 'c1', supported: ['win32'], availability });
	assert.deepEqual(state.selected, ['win32']);
	assert.deepEqual(state.removed, ['darwin', 'ps5']);
});
