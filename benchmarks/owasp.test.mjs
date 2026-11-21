import test from 'node:test';
import assert from 'node:assert/strict';
import {categoryOf, flaggedTests, markdown, parseExpected, score} from './owasp.mjs';

const csv = `# test name, category, real vulnerability, cwe, Benchmark version: 1.2
BenchmarkTest00001,sqli,true,89
BenchmarkTest00002,sqli,true,89
BenchmarkTest00003,sqli,false,89
BenchmarkTest00004,sqli,false,89
BenchmarkTest00005,hash,true,328
BenchmarkTest00006,hash,false,328`;
const finding = (ruleId, uri) => ({ruleId, locations: [{physicalLocation: {artifactLocation: {uri}}}]});
const sarif = {runs: [{results: [
  finding('taint-sql', 'BenchmarkTest00001.java'),
  finding('sql-string-concatenation', 'BenchmarkTest00003.java'),
  finding('weak-cryptographic-hash', 'BenchmarkTest00001.java'),
  finding('hardcoded-credential', 'BenchmarkTest00006.java'),
  finding('weak-cryptographic-hash', 'helpers/Thing.java')
]}]};

test('maps rule ids and CWE ids to OWASP categories', () => {
  assert.equal(categoryOf('taint-sql'), 'sqli');
  assert.equal(categoryOf('java-cookie-insecure'), 'securecookie');
  assert.equal(categoryOf('potential-command-execution'), 'cmdi');
  assert.equal(categoryOf('CWE-79'), 'xss');
  assert.equal(categoryOf('hardcoded-credential'), undefined);
});

test('scores only findings whose category matches the test case', () => {
  const {flagged, unmapped, outside} = flaggedTests(sarif);
  assert.deepEqual([unmapped, outside], [1, 1]);
  const {categories, overall} = score(parseExpected(csv), flagged);
  assert.deepEqual(categories.sqli, {tests: 4, tp: 1, fp: 1, tn: 1, fn: 1, tpr: 0.5, fpr: 0.5, score: 0});
  assert.deepEqual(categories.hash, {tests: 2, tp: 0, fp: 0, tn: 1, fn: 1, tpr: 0, fpr: 0, score: 0});
  assert.equal(overall.tests, 6);
  assert.equal(overall.tpr, 0.25);
  assert.match(markdown({categories, overall}), /\| sqli \| 4 \| 1 \| 1 \| 1 \| 1 \| 50\.0% \| 50\.0% \| 0\.0% \|/);
});
