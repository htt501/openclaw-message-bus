import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateMsgId } from '../../src/id.js';

describe('generateMsgId', () => {
  it('should match the expected format msg_{agentId}_{timestamp}_{hex4}', () => {
    const id = generateMsgId('main');
    assert.match(id, /^msg_main_\d+_[0-9a-f]{4}$/);
  });

  it('should embed the agentId in the msg_id', () => {
    for (const agent of ['main', 'ops', 'creator', 'intel', 'strategist']) {
      const id = generateMsgId(agent);
      assert.ok(id.startsWith(`msg_${agent}_`), `Expected id to start with msg_${agent}_, got ${id}`);
    }
  });

  it('should generate unique ids across multiple calls', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateMsgId('main'));
    }
    // With 4 hex digits (65536 possibilities) and 100 calls, collisions are extremely unlikely
    assert.equal(ids.size, 100, 'Expected 100 unique ids');
  });

  it('should include a recent timestamp', () => {
    const before = Date.now();
    const id = generateMsgId('ops');
    const after = Date.now();
    const ts = parseInt(id.split('_')[2], 10);
    assert.ok(ts >= before && ts <= after, `Timestamp ${ts} not in range [${before}, ${after}]`);
  });
});
