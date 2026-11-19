// Run after `yarn build`: node --test tests/task-manager-throwing-task.test.cjs
// A task whose execute() throws must not stop the tasks queued after it, nor make an earlier
// task run twice a cycle (the list was left half compacted when the throw escaped the loop).
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

const { TaskManager } = require('../dist/game/task/TaskManager');
const { Task } = require('../dist/game/task/Task');

class Counting extends Task {
  constructor(delay = 1) { super(delay); this.runs = 0; }
  execute() { this.runs++; }
}

class Once extends Task {
  constructor() { super(1); this.runs = 0; }
  execute() { this.runs++; this.stop(); }
}

class Throwing extends Task {
  constructor(delay = 1) { super(delay); this.attempts = 0; }
  execute() { this.attempts++; throw new Error('task failure (expected by this test)'); }
}

const quiet = (fn) => {
  const error = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };
  try { fn(); } finally { console.error = error; }
  return logged;
};

beforeEach(() => {
  // Leave no task of an earlier test behind.
  for (const task of [...TaskManager.activeTasks, ...TaskManager.pendingTasks.toArray()]) task.stop();
  quiet(() => TaskManager.process());
});

test('a throwing task does not stop the tasks after it', () => {
  const before = new Counting(), bad = new Throwing(), after = new Counting();
  for (const task of [before, bad, after]) TaskManager.submit(task);
  quiet(() => { for (let cycle = 0; cycle < 5; cycle++) TaskManager.process(); });
  assert.equal(before.runs, 5);
  assert.equal(after.runs, 5, 'the task queued after the throwing one ran every cycle');
  bad.stop(); before.stop(); after.stop();
});

test('a throwing task does not make an earlier task run twice a cycle', () => {
  const first = new Counting(), finishing = new Once(), kept = new Counting(), bad = new Throwing();
  for (const task of [first, finishing, kept, bad]) TaskManager.submit(task);
  quiet(() => { for (let cycle = 0; cycle < 6; cycle++) TaskManager.process(); });
  assert.equal(finishing.runs, 1);
  assert.equal(first.runs, 6);
  assert.equal(kept.runs, 6, 'one run a cycle, not two');
  for (const task of [first, kept, bad]) task.stop();
});

test('a task that keeps throwing waits its delay between attempts and is reported once, not every cycle', () => {
  const bad = new Throwing(4);
  TaskManager.submit(bad);
  const logged = quiet(() => { for (let cycle = 0; cycle < 40; cycle++) TaskManager.process(); });
  assert.equal(bad.attempts, 10, 'every fourth cycle');
  assert.ok(logged.length >= 1, 'the failure is reported');
  assert.ok(logged.length <= 2, `not reported every attempt (${logged.length} reports of ${bad.attempts} attempts)`);
  bad.stop();
});
