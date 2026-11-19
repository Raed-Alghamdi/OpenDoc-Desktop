import test from 'node:test';
import assert from 'node:assert/strict';
import { marqueeComponents, type MarqueeCandidate } from '../src/app/marqueeHits';

const item = (id: string, left: number, top: number, right: number, bottom: number): MarqueeCandidate => ({ id, page: 1, left, top, right, bottom });
// A list holding three items, with a paragraph above it.
const page = [
  item('paragraph', 0, 0, 100, 40),
  item('list', 0, 60, 100, 150),
  item('first', 10, 60, 100, 80), item('second', 10, 90, 100, 110), item('third', 10, 120, 100, 150),
];
const ids = (box: { left: number; top: number; right: number; bottom: number }) => marqueeComponents(box, page).map(hit => hit.id).sort();

test('a box through one list item chooses that item, not the whole list', () => {
  assert.deepEqual(ids({ left: 50, top: 95, right: 60, bottom: 100 }), ['second']);
});

test('a box that encloses the list chooses the list once, with what it holds', () => {
  assert.deepEqual(ids({ left: -5, top: 55, right: 105, bottom: 155 }), ['list']);
});

test('a box over part of a list chooses the items it encloses and the one it touches', () => {
  assert.deepEqual(ids({ left: -5, top: 55, right: 105, bottom: 95 }), ['first', 'second']);
});

test('a box across two components chooses both, and an empty box chooses none', () => {
  assert.deepEqual(ids({ left: 40, top: 30, right: 60, bottom: 70 }), ['first', 'paragraph']);
  assert.deepEqual(ids({ left: 200, top: 0, right: 220, bottom: 20 }), []);
});

test('edges that only touch do not choose a component', () => {
  assert.deepEqual(ids({ left: 0, top: 40, right: 100, bottom: 60 }), []);
});
