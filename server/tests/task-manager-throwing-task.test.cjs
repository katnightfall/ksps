// Run after `yarn build`: node --test tests/task-manager-throwing-task.test.cjs
//
// One task whose execute() throws must cost only itself. The pass used to end at the throw: the
// tasks after it in the list got no turn while it kept throwing, and a task before it that had
// already been moved down the list (because an earlier task had finished) was left in the list
// twice and ran twice a cycle from then on.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TaskManager } = require("../dist/game/task/TaskManager");
const { Task } = require("../dist/game/task/Task");

class Counting extends Task {
  constructor(runs) {
    super(1);
    this.left = runs;
    this.count = 0;
  }
  execute() {
    this.count++;
    if (--this.left <= 0) this.stop();
  }
}

class Throwing extends Task {
  constructor() {
    super(1);
    this.count = 0;
  }
  execute() {
    this.count++;
    throw new Error("a broken task");
  }
}

test("a task that throws does not starve the tasks after it or double the tasks before it", (t) => {
  t.mock.method(console, "error", () => {});
  const finishesFirstCycle = new Counting(1);
  const before = new Counting(1000);
  const broken = new Throwing();
  const after = new Counting(1000);
  for (const task of [finishesFirstCycle, before, broken, after]) TaskManager.submit(task);
  t.after(() => { for (const task of [before, broken, after]) task.stop(); TaskManager.process(); });

  const cycles = 5;
  for (let i = 0; i < cycles; i++) TaskManager.process();

  assert.equal(finishesFirstCycle.count, 1);
  assert.equal(after.count, cycles, "the task after the broken one runs once a cycle");
  assert.equal(before.count, cycles, "the task before the broken one runs once a cycle, not twice");
  assert.equal(broken.count, cycles, "the broken task is tried again each cycle, as before");
  assert.equal(TaskManager.getTaskAmount(), 3, "no task is in the list twice");
});
