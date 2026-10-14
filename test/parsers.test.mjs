import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDoh, parseRdap, parseWhoisCom, parseWhoisEu, parseWhoisBg, Throttled } from '../src/check.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const json = (f) => JSON.parse(fx(f));

test('DoH: only a positive NS answer is taken', () => {
  assert.equal(parseDoh(fx('doh-ns.json')), 'taken');
  assert.equal(parseDoh(fx('doh-noerror-empty.json')), 'maybe');
  assert.equal(parseDoh(fx('doh-nxdomain.json')), 'maybe');
  assert.equal(parseDoh(fx('doh-google-nxdomain.json')), 'maybe');
  assert.equal(parseDoh(fx('doh-servfail.json')), 'maybe');
  assert.throws(() => parseDoh(fx('doh-malformed.txt')));
});

test('RDAP .com', () => {
  assert.equal(parseRdap(json('rdap-com-taken.json').status), 'taken');
  assert.equal(parseRdap(json('rdap-com-free.json').status), 'free');
  assert.throws(() => parseRdap(429), Throttled);
  assert.throws(() => parseRdap(500));
});

test('WHOIS .com', () => {
  assert.equal(parseWhoisCom(fx('whois-com-taken.txt')), 'taken');
  assert.equal(parseWhoisCom(fx('whois-com-free.txt')), 'free');
  assert.throws(() => parseWhoisCom('Rate limit exceeded'), Throttled);
});

test('WHOIS .eu, reserved counts as taken', () => {
  assert.equal(parseWhoisEu(fx('whois-eu-taken.txt')), 'taken');
  assert.equal(parseWhoisEu(fx('whois-eu-free.txt')), 'free');
  assert.equal(parseWhoisEu(fx('whois-eu-reserved.txt')), 'taken');
  assert.throws(() => parseWhoisEu(''), Throttled);
});

test('WHOIS .bg', () => {
  assert.equal(parseWhoisBg(fx('whois-bg-taken.synthetic.txt')), 'taken');
  assert.equal(parseWhoisBg(fx('whois-bg-free.synthetic.txt')), 'free');
  assert.throws(() => parseWhoisBg(fx('whois-bg-throttle.txt')), Throttled);
});
