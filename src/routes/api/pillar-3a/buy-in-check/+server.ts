import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { PILLAR_3A_CURRENCY } from "$lib/pillar-3a";
import { requireUser } from "$lib/server/auth/guards";
import { localToday } from "$lib/server/ledger";
import { dateSchema, parseMoneyInput } from "$lib/server/ledger/schemas";
import { checkBuyIn } from "$lib/server/pillar3a";
import type { RequestHandler } from "./$types";

const gapYears = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .filter((p) => p.trim() !== "")
      .map(Number),
  )
  .pipe(z.array(z.number().int().min(1990).max(2200)).max(20));

const querySchema = z.object({
  key: z.string().max(100).optional(),
  date: dateSchema,
  gapYears,
});

/** Live preview of the buy-in rules for the contribution dialog (read-only). */
export const GET: RequestHandler = ({ locals, url }) => {
  const user = requireUser(locals);
  const parsed = querySchema.safeParse({
    key: url.searchParams.get("key") ?? undefined,
    date: url.searchParams.get("date") ?? "",
    gapYears: url.searchParams.get("gapYears") ?? "",
  });
  if (!parsed.success) error(400, "Invalid buy-in check request.");
  const amount = parseMoneyInput(
    url.searchParams.get("amount") ?? "",
    PILLAR_3A_CURRENCY,
  );
  if (!amount.ok || amount.value <= 0) {
    return json({ errors: [], warnings: [] });
  }
  return json(
    checkBuyIn(
      user.id,
      {
        key: parsed.data.key ?? null,
        date: parsed.data.date,
        amount: amount.value,
        gapYears: parsed.data.gapYears,
      },
      localToday(),
    ),
  );
};
