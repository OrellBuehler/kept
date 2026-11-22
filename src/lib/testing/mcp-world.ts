import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories";
import { createTestUser } from "./auth";
import { seedBill } from "./bills";
import { seedAccount, seedImportedTransaction } from "./ledger";

const category = (userId: string, name: string) =>
  createCategory(userId, {
    name,
    kind: "expense",
    parentId: null,
    color: null,
    icon: null,
  });

/**
 * Two users with some data each. Owner `a` has two accounts and two
 * categories; payments sit in every combination, so that a restriction to one
 * account or one category hides something in each dimension. `b` is another
 * user whose rows must never show up for `a`'s credentials.
 */
export async function buildWorld() {
  const a = await createTestUser();
  const b = await createTestUser();

  const checking = await seedAccount(a.id, { name: "Checking" });
  const savings = await seedAccount(a.id, { name: "Savings", type: "savings" });
  const food = await category(a.id, "Food");
  const rent = await category(a.id, "Rent");

  const pay = (
    accountId: string,
    over: Parameters<typeof seedImportedTransaction>[2],
  ) => seedImportedTransaction(a.id, accountId, over);

  // checking / food
  const t1 = await pay(checking.id, {
    bookingDate: "2026-03-10",
    amount: minor(-1250),
    counterpartyName: "Shop One",
    description: "groceries one",
    categoryId: food.id,
  });
  // checking / rent: pays bill 1 in full
  const t2 = await pay(checking.id, {
    bookingDate: "2026-03-11",
    amount: minor(-10000),
    counterpartyName: "Example Supplier",
    description: "invoice payment",
    categoryId: rent.id,
  });
  // savings / food
  const t3 = await pay(savings.id, {
    bookingDate: "2026-03-12",
    amount: minor(-500),
    counterpartyName: "Shop Two",
    description: "groceries two",
    categoryId: food.id,
  });
  // savings / uncategorized
  const t4 = await pay(savings.id, {
    bookingDate: "2026-03-13",
    amount: minor(-700),
    counterpartyName: "Kiosk",
    description: "snacks",
  });
  // checking / uncategorized
  const t5 = await pay(checking.id, {
    bookingDate: "2026-03-14",
    amount: minor(-300),
    counterpartyName: "Cafe",
    description: "coffee",
  });

  const bill1 = await seedBill(a.id, {
    creditorName: "Example Supplier",
    amount: minor(10000),
    dueDate: "2026-04-01",
    issueDate: "2026-03-01",
  });
  const bill2 = await seedBill(a.id, {
    creditorName: "Second Supplier",
    amount: minor(2500),
    dueDate: "2026-05-01",
  });

  const bAccount = await seedAccount(b.id, { name: "Other checking" });
  const bFood = await category(b.id, "Other food");
  const bTx = await seedImportedTransaction(b.id, bAccount.id, {
    bookingDate: "2026-03-10",
    amount: minor(-9999),
    counterpartyName: "Foreign Shop",
    description: "foreign",
    categoryId: bFood.id,
  });
  const bBill = await seedBill(b.id, {
    creditorName: "Foreign Supplier",
    amount: minor(7777),
  });

  return {
    a,
    b,
    checking,
    savings,
    food,
    rent,
    t1,
    t2,
    t3,
    t4,
    t5,
    bill1,
    bill2,
    bAccount,
    bFood,
    bTx,
    bBill,
  };
}

export type World = Awaited<ReturnType<typeof buildWorld>>;
