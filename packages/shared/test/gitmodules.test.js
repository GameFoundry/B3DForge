'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGitmodules, resolveSubmoduleUrl } = require('../dist/utils/gitmodules.js');

const GITMODULES = `[submodule "Framework"]
	path = Framework
	url = https://example.com/B3DFramework.git
	branch = staging
[submodule "Framework/Platform/PS5"]
\tpath = Framework/Platform/PS5
\turl = https://example.com/placeholder.git
\tupdate = none
[submodule "Tools/CodeGen"]
	path = Tools/CodeGen
	url = ../B3DCodeGen.git
`;

test('parseGitmodules reads name, path, url, branch and update', () => {
	const entries = parseGitmodules(GITMODULES);
	assert.equal(entries.length, 3);
	assert.deepEqual(entries[0], { name: 'Framework', path: 'Framework', url: 'https://example.com/B3DFramework.git', branch: 'staging', update: undefined });
	assert.equal(entries[1].update, 'none');
	assert.equal(entries[2].url, '../B3DCodeGen.git');
	assert.equal(entries[2].branch, undefined);
});

test('parseGitmodules tolerates CRLF and skips entries without a path', () => {
	const entries = parseGitmodules('[submodule "a"]\r\n\tpath = a\r\n\turl = u\r\n[submodule "b"]\r\n\turl = only-url\r\n');
	assert.equal(entries.length, 1);
	assert.equal(entries[0].path, 'a');
});

test('resolveSubmoduleUrl handles relative .gitmodules urls', () => {
	assert.equal(resolveSubmoduleUrl('https://host/org/Editor.git', '../Framework.git'), 'https://host/org/Framework.git');
	assert.equal(resolveSubmoduleUrl('git@host:org/Editor.git', '../Framework.git'), 'git@host:org/Framework.git');
	assert.equal(resolveSubmoduleUrl('https://host/org/Editor.git', './Sub.git'), 'https://host/org/Editor.git/Sub.git');
	assert.equal(resolveSubmoduleUrl('https://host/org/Editor.git', 'https://other/Framework.git'), 'https://other/Framework.git');
});
