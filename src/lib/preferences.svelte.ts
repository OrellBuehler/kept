import { getContext, setContext } from "svelte";
import { formatDate, formatDateTime, formatMonth } from "$lib/format";
import { formatIban, maskIban } from "$lib/iban";
import { formatAmount, type Minor } from "$lib/money";
import { DEFAULT_PREFERENCES, type Preferences } from "$lib/preferences";

const KEY = Symbol("kept.preferences");

export class PreferencesState {
  value = $state<Preferences>({ ...DEFAULT_PREFERENCES });

  constructor(initial: Preferences = DEFAULT_PREFERENCES) {
    this.value = { ...initial };
  }

  get locale() {
    return this.value.locale;
  }
  get blur() {
    return this.value.blurAmounts;
  }
  get defaultCurrency() {
    return this.value.defaultCurrency;
  }
  get ibanDisplay() {
    return this.value.ibanDisplay;
  }
  get pageSize() {
    return this.value.pageSize;
  }

  sync(next: Preferences) {
    this.value = { ...next };
  }

  setBlur(blur: boolean) {
    this.value.blurAmounts = blur;
  }

  amount(value: Minor, currency: string) {
    return formatAmount(value, currency, this.locale);
  }

  date(iso: string) {
    return formatDate(iso, this.locale);
  }

  dateTime(ms: number, timeZone?: string) {
    return formatDateTime(ms, timeZone, this.locale);
  }

  month(month: string, style: "long" | "short" = "long", withYear = true) {
    return formatMonth(month, this.locale, style, withYear);
  }

  /** Display form of an IBAN, or `null` when the user hides IBANs. */
  iban(iban: string): string | null {
    if (this.ibanDisplay === "hidden") return null;
    return this.ibanDisplay === "masked" ? maskIban(iban) : formatIban(iban);
  }
}

/** Call once from the (app) layout; `sync` it whenever the loaded preferences change. */
export function setPreferences(initial: Preferences): PreferencesState {
  return setContext(KEY, new PreferencesState(initial));
}

/** Outside the (app) layout there is no context, so defaults apply. */
export function usePreferences(): PreferencesState {
  return (
    getContext<PreferencesState | undefined>(KEY) ?? new PreferencesState()
  );
}
