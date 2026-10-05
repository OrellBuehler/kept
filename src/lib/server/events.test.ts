import { afterEach, describe, expect, it, vi } from "vitest";
import { drainDetached } from "$lib/server/detached";
import { createTestUser } from "$lib/testing/auth";
import { seedBill, billInput } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { updateBill, cancelBill, uncancelBill } from "$lib/server/bills/bills";
import { clearEventListeners, emitBillChanged, onBillChanged } from "./events";

afterEach(() => {
  clearEventListeners();
  vi.restoreAllMocks();
});

describe("event bus", () => {
  useTestDB();

  it("delivers bill changes to subscribers until they unsubscribe", () => {
    const seen: string[] = [];
    const off = onBillChanged((u, b) => void seen.push(`${u}/${b}`));
    emitBillChanged("u1", "b1");
    off();
    emitBillChanged("u1", "b2");
    expect(seen).toEqual(["u1/b1"]);
  });

  it("a throwing or rejecting listener does not stop the others or the caller", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onBillChanged(() => {
      throw new Error("secret detail");
    });
    onBillChanged(async () => {
      throw Object.assign(new Error("secret detail"), { code: "boom" });
    });
    onBillChanged((_u, b) => void seen.push(b));
    expect(() => emitBillChanged("u", "b")).not.toThrow();
    await drainDetached();
    expect(seen).toEqual(["b"]);
    expect(errors).toHaveBeenCalledTimes(2);
    // Only codes are logged, never messages.
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret detail");
  });

  it("the core emits when a bill is created, updated or cancelled", async () => {
    const u = await createTestUser();
    const seen: Array<[string, string]> = [];
    onBillChanged((user, bill) => void seen.push([user, bill]));
    const bill = await seedBill(u.id);
    await updateBill(u.id, bill.id, billInput({ creditorName: "Renamed" }));
    await cancelBill(u.id, bill.id);
    await uncancelBill(u.id, bill.id);
    expect(seen).toEqual([
      [u.id, bill.id],
      [u.id, bill.id],
      [u.id, bill.id],
      [u.id, bill.id],
    ]);
  });

  it("a failing listener never breaks the core operation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const u = await createTestUser();
    onBillChanged(() => {
      throw new Error("listener bug");
    });
    const bill = await seedBill(u.id);
    expect(bill.id).toBeTruthy();
    expect(
      (
        await updateBill(
          u.id,
          bill.id,
          billInput({ creditorName: "Still works" }),
        )
      ).creditorName,
    ).toBe("Still works");
  });
});
