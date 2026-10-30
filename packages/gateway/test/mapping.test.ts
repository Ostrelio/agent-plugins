import { describe, expect, it } from 'vitest';
import type { ActionMapping } from '../src/config.js';
import { MappingError, buildProposal, callHash, canonicalJson, readPath } from '../src/mapping.js';

const action = (overrides: Partial<ActionMapping> = {}): ActionMapping => ({
  tool: 'fake.create_refund', actionType: 'refund.create', resourceType: 'charge', map: {}, ...overrides,
});

describe('readPath', () => {
  const args = { a: { b: { c: 7 } }, n: null, zero: 0, list: [1, 2] };

  it('returns the whole value for $', () => {
    expect(readPath(args, '$')).toBe(args);
  });

  it('reads nested paths', () => {
    expect(readPath(args, '$.a.b.c')).toBe(7);
    expect(readPath(args, '$.a.b')).toEqual({ c: 7 });
    expect(readPath(args, '$.zero')).toBe(0);
    expect(readPath(args, '$.n')).toBeNull();
  });

  it('gives undefined for missing segments', () => {
    expect(readPath(args, '$.missing')).toBeUndefined();
    expect(readPath(args, '$.a.x.c')).toBeUndefined();
    expect(readPath(args, '$.zero.deeper')).toBeUndefined();
    expect(readPath(args, '$.list.0')).toBeUndefined();
  });

  it('does not read inherited properties', () => {
    expect(readPath(args, '$.toString')).toBeUndefined();
    expect(readPath(args, '$.constructor')).toBeUndefined();
    expect(readPath(args, '$.__proto__')).toBeUndefined();
  });
});

describe('buildProposal', () => {
  it('maps paths and literals into the proposal', () => {
    const proposal = buildProposal(action({
      map: { resourceId: '$.charge', 'context.amount': '$.amount', 'context.currency': 'USD' },
    }), 'fake.create_refund', { charge: 'ch_1', amount: 1000 });
    expect(proposal).toEqual({
      actionType: 'refund.create', resourceType: 'charge', resourceId: 'ch_1',
      context: { amount: 1000, currency: 'USD' },
    });
  });

  it('keeps non-string values from arguments as they are', () => {
    const proposal = buildProposal(action({ map: { 'context.items': '$.items', 'context.flag': '$.flag', 'context.none': '$.none' } }),
      'fake.create_refund', { items: [1, { a: 2 }], flag: false, none: null });
    expect(proposal.context).toEqual({ items: [1, { a: 2 }], flag: false, none: null });
  });

  it('builds nested context objects', () => {
    const proposal = buildProposal(action({
      map: { 'context.amount.value': '$.amount', 'context.amount.currency': '$.currency', 'context.customer.id': '$.customer.id' },
    }), 't', { amount: 5, currency: 'EUR', customer: { id: 'c1' } });
    expect(proposal.context).toEqual({ amount: { value: 5, currency: 'EUR' }, customer: { id: 'c1' } });
  });

  it('defaults resourceId to the exposed tool name', () => {
    expect(buildProposal(action(), 'fake.get_balance', {}).resourceId).toBe('fake.get_balance');
  });

  it('stringifies a numeric resourceId', () => {
    expect(buildProposal(action({ map: { resourceId: '$.id' } }), 't', { id: 42 }).resourceId).toBe('42');
  });

  it('refuses a call that omits a mapped context argument, so the policy never sees less than it checks', () => {
    const mapped = action({ map: { 'context.amount': '$.amount', 'context.note': '$.note' } });
    expect(() => buildProposal(mapped, 't', { amount: 1 })).toThrow('Argument $.note is required for context.note.');
  });

  it('refuses a resourceId that is not a string or finite number', () => {
    const mapped = action({ map: { resourceId: '$.charge' } });
    expect(() => buildProposal(mapped, 't', { charge: { id: 'a' } })).toThrow('Argument $.charge must be a string or a number for resourceId.');
    expect(() => buildProposal(mapped, 't', { charge: ['a'] })).toThrow(MappingError);
    expect(() => buildProposal(mapped, 't', { charge: true })).toThrow(MappingError);
  });

  it('throws a MappingError when the resourceId path is missing or null', () => {
    const mapped = action({ map: { resourceId: '$.charge' } });
    expect(() => buildProposal(mapped, 't', {})).toThrow(MappingError);
    expect(() => buildProposal(mapped, 't', {})).toThrow('Argument $.charge is required for resourceId.');
    expect(() => buildProposal(mapped, 't', { charge: null })).toThrow(MappingError);
  });

  it('refuses an empty or blank resourceId with the argument name', () => {
    const mapped = action({ map: { resourceId: '$.charge' } });
    expect(() => buildProposal(mapped, 't', { charge: '' })).toThrow('Argument $.charge must not be empty for resourceId.');
    expect(() => buildProposal(mapped, 't', { charge: '   ' })).toThrow(MappingError);
    expect(buildProposal(mapped, 't', { charge: 0 }).resourceId).toBe('0');
  });

  it('resolves resourceType from the map, literal or path', () => {
    expect(buildProposal(action({ map: { resourceType: 'invoice' } }), 't', {}).resourceType).toBe('invoice');
    expect(buildProposal(action({ map: { resourceType: '$.kind' } }), 't', { kind: 'payment' }).resourceType).toBe('payment');
    expect(() => buildProposal(action({ map: { resourceType: '$.kind' } }), 't', {}))
      .toThrow('Argument $.kind is required for resourceType.');
  });

  it('throws when no resourceType exists anywhere', () => {
    const noType: Partial<ActionMapping> = action();
    delete noType.resourceType;
    expect(() => buildProposal(noType as ActionMapping, 'fake.x', {})).toThrow(MappingError);
  });
});

describe('canonicalJson', () => {
  it('does not depend on key order, at any depth', () => {
    const a = { x: 1, y: { b: [{ q: 1, p: 2 }], a: 'z' } };
    const b = { y: { a: 'z', b: [{ p: 2, q: 1 }] }, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"x":1,"y":{"a":"z","b":[{"p":2,"q":1}]}}');
  });

  it('keeps array order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('callHash', () => {
  it('is a stable hex sha-256', () => {
    expect(callHash('fake.t', { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(callHash('fake.t', { a: 1 })).toBe(callHash('fake.t', { a: 1 }));
  });

  it('ignores key order', () => {
    expect(callHash('fake.t', { a: 1, b: { c: 2, d: 3 } })).toBe(callHash('fake.t', { b: { d: 3, c: 2 }, a: 1 }));
  });

  it('differs for different arguments or tools', () => {
    expect(callHash('fake.t', { a: 1 })).not.toBe(callHash('fake.t', { a: 2 }));
    expect(callHash('fake.t', { a: 1 })).not.toBe(callHash('fake.u', { a: 1 }));
  });
});
