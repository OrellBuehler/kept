import { requireUser } from "$lib/server/auth/guards";
import { localToday } from "$lib/server/ledger/balances";
import {
  defaultReviewYear,
  reviewYears,
  yearReview,
  yearSchema,
} from "$lib/server/review";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  const user = requireUser(locals);
  const today = localToday();
  const years = reviewYears(user.id);
  const requested = yearSchema(today).safeParse(url.searchParams.get("year"));
  const year = requested.success
    ? requested.data
    : defaultReviewYear(today, years);
  return {
    year,
    currentYear: Number(today.slice(0, 4)),
    firstYear: years.length ? Math.min(...years, year) : year,
    review: yearReview(user.id, { year, today }),
  };
};
