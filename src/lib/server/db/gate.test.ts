import { afterEach, describe, expect, it, vi } from "vitest";
import { Gate, GateResetError, GateTimeoutError, GateToken } from "./gate";

afterEach(() => {
  vi.restoreAllMocks();
});

const token = (label = "t") => new GateToken(label);

describe("Gate", () => {
  it("is taken immediately when free and freed on release", () => {
    const gate = new Gate(1000);
    const a = token();
    expect(gate.free).toBe(true);
    expect(gate.tryAcquire(a)).toBe(true);
    expect(gate.free).toBe(false);
    expect(gate.tryAcquire(token())).toBe(false);
    gate.release(a);
    expect(gate.free).toBe(true);
    expect(a.active).toBe(false);
  });

  it("hands ownership to waiters strictly in arrival order", async () => {
    const gate = new Gate(1000);
    const order: string[] = [];
    const a = token("a");
    gate.tryAcquire(a);
    const run = async (name: string) => {
      const t = token(name);
      await gate.acquire(t);
      order.push(name);
      // The new owner is in place the moment the previous one releases.
      expect(gate.owner).toBe(t);
      await Promise.resolve();
      gate.release(t);
    };
    const waiting = [run("b"), run("c"), run("d")];
    expect(gate.waiting).toBe(3);
    gate.release(a);
    await Promise.all(waiting);
    expect(order).toEqual(["b", "c", "d"]);
    expect(gate.free).toBe(true);
  });

  it("does not let a late arrival overtake a woken waiter", async () => {
    const gate = new Gate(1000);
    const a = token("a");
    gate.tryAcquire(a);
    const b = token("b");
    const acquiredB = gate.acquire(b);
    gate.release(a);
    // b owns the gate although its continuation has not run yet.
    expect(gate.owner).toBe(b);
    expect(gate.tryAcquire(token("late"))).toBe(false);
    await acquiredB;
    gate.release(b);
  });

  it("refuses a release from a caller that does not own the gate", () => {
    const gate = new Gate(1000);
    gate.tryAcquire(token());
    expect(() => gate.release(token())).toThrow(/does not own/);
  });

  it("times out a waiter, logs the owner's stack and keeps serving the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = new Gate(20);
    const owner = new GateToken("long transaction", true);
    gate.tryAcquire(owner);
    const impatient = token("impatient");
    await expect(gate.acquire(impatient)).rejects.toBeInstanceOf(
      GateTimeoutError,
    );
    expect(gate.waiting).toBe(0);
    expect(error).toHaveBeenCalledOnce();
    const logged = error.mock.calls[0]!.join(" ");
    expect(logged).toContain("long transaction");
    expect(logged).toContain("gate.test.ts");

    // The timed-out waiter is gone: releasing frees the gate instead of
    // handing it to a caller that already gave up.
    gate.release(owner);
    expect(gate.free).toBe(true);
  });

  it("does not time out a waiter that was served in time", async () => {
    const gate = new Gate(30);
    const a = token();
    gate.tryAcquire(a);
    const b = token();
    const acquired = gate.acquire(b);
    gate.release(a);
    await acquired;
    await new Promise((r) => setTimeout(r, 60));
    expect(gate.owner).toBe(b);
    gate.release(b);
  });

  it("reset frees the gate and fails everyone waiting", async () => {
    const gate = new Gate(1000);
    const a = token();
    gate.tryAcquire(a);
    const waiter = gate.acquire(token());
    gate.reset();
    await expect(waiter).rejects.toBeInstanceOf(GateResetError);
    expect(gate.free).toBe(true);
    expect(a.active).toBe(false);
  });
});
