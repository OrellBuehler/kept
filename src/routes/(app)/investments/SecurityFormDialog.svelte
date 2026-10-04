<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { COMMON_CURRENCIES } from "$lib/account-types";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { SECURITY_KIND_LABELS } from "$lib/investment-labels";
  import { SECURITY_KINDS, type SecurityKind } from "$lib/investment-types";
  import { usePreferences } from "$lib/preferences.svelte";
  import SearchIcon from "@lucide/svelte/icons/search";
  import type { PageData } from "./$types";

  type Security = PageData["securities"][number];
  interface Match {
    symbol: string;
    name: string;
    currency: string | null;
    kind: SecurityKind | null;
    isin: string | null;
  }

  const prefs = usePreferences();

  let {
    open = $bindable(false),
    security = null,
    canLookup,
    lookupEnabled,
  }: {
    open?: boolean;
    security?: Security | null;
    /** Market data is on and a provider is registered. */
    canLookup: boolean;
    /** The user turned market data on (a provider may still be missing). */
    lookupEnabled: boolean;
  } = $props();

  const uid = $props.id();
  const editing = $derived(security !== null);
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let name = $state("");
  let kind = $state<SecurityKind>("etf");
  let isin = $state("");
  let symbol = $state("");
  let currency = $state("");

  let query = $state("");
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let matches = $state<Match[] | null>(null);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      name = security?.name ?? "";
      kind = security?.kind ?? "etf";
      isin = security?.isin ?? "";
      symbol = security?.symbol ?? "";
      currency = security?.currency ?? prefs.defaultCurrency;
      query = "";
      searchError = null;
      matches = null;
    });
  });

  function pick(m: Match) {
    name = m.name;
    symbol = m.symbol;
    if (m.kind) kind = m.kind;
    if (m.isin) isin = m.isin;
    if (m.currency) currency = m.currency;
    matches = null;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit security" : "Add security"}</Dialog.Title>
      <Dialog.Description>
        An ETF, stock or fund you hold. Without a symbol, prices are entered by
        hand.
      </Dialog.Description>
    </Dialog.Header>

    {#if canLookup}
      <form
        method="POST"
        action="?/lookup"
        class="grid gap-2"
        use:enhance={() => {
          searching = true;
          searchError = null;
          return async ({ result }) => {
            searching = false;
            if (result.type === "success") {
              matches = (result.data?.matches ?? []) as Match[];
            } else if (result.type === "failure") {
              const e = (result.data?.errors ?? {}) as NonNullable<FormErrors>;
              searchError = Object.values(e).flat()[0] ?? "Lookup failed.";
            } else {
              console.error("lookup failed", result);
              searchError = "Something went wrong. Please try again.";
            }
          };
        }}
      >
        <label for="{uid}-q" class="text-sm font-medium">Look up</label>
        <div class="flex gap-2">
          <Input
            id="{uid}-q"
            name="q"
            bind:value={query}
            autocomplete="off"
            placeholder="ISIN or name"
            maxlength={100}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={searching || query.trim().length < 2}
          >
            {#if searching}<Spinner />{:else}<SearchIcon />{/if}
            Search
          </Button>
        </div>
        <p class="text-muted-foreground text-xs">
          Sends your search text to the market data provider.
        </p>
        {#if searchError}
          <p class="text-destructive text-sm" role="alert">{searchError}</p>
        {/if}
        {#if matches}
          {#if matches.length === 0}
            <p class="text-muted-foreground text-sm">No matches.</p>
          {:else}
            <ul class="grid gap-1 rounded-md border p-1">
              {#each matches as m (m.symbol)}
                <li>
                  <button
                    type="button"
                    class="hover:bg-accent focus-visible:ring-ring/50 flex w-full min-w-0 flex-wrap items-center justify-between gap-x-3 rounded-sm px-2 py-1.5 text-start text-sm outline-none focus-visible:ring-[3px]"
                    onclick={() => pick(m)}
                  >
                    <span class="min-w-0 break-words">{m.name}</span>
                    <span class="flex items-center gap-2">
                      <span class="font-mono text-xs">{m.symbol}</span>
                      {#if m.kind}
                        <Badge variant="outline">
                          {SECURITY_KIND_LABELS[m.kind]}
                        </Badge>
                      {/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </form>
    {:else}
      <p class="text-muted-foreground text-xs">
        {#if lookupEnabled}
          No market data provider is available, so symbols are entered by hand.
        {:else}
          <a
            href={resolve("/(app)/settings/market-data")}
            class="hover:text-foreground underline underline-offset-2"
          >
            Turn on market data
          </a>
          to look up securities by ISIN or name.
        {/if}
      </p>
    {/if}

    <form
      method="POST"
      action={editing ? "?/updateSecurity" : "?/createSecurity"}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: ["name", "kind", "isin", "symbol", "currency"],
        successMessage: editing ? "Security updated" : "Security added",
        onSuccess: () => (open = false),
      })}
    >
      {#if security}
        <input type="hidden" name="securityId" value={security.id} />
      {/if}
      <input type="hidden" name="kind" value={kind} />

      <FormField label="Name" for="{uid}-name" errors={errors.name}>
        <Input
          id="{uid}-name"
          name="name"
          required
          maxlength={120}
          placeholder="Example World ETF"
          bind:value={name}
          aria-invalid={!!errors.name}
        />
      </FormField>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField label="Type" for="{uid}-kind" errors={errors.kind}>
          <Select.Root type="single" bind:value={kind}>
            <Select.Trigger id="{uid}-kind" aria-label="Type" class="w-full">
              {SECURITY_KIND_LABELS[kind]}
            </Select.Trigger>
            <Select.Content>
              {#each SECURITY_KINDS as k (k)}
                <Select.Item value={k} label={SECURITY_KIND_LABELS[k]}>
                  {SECURITY_KIND_LABELS[k]}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </FormField>
        <FormField
          label="Currency"
          for="{uid}-currency"
          errors={errors.currency}
          hint="The currency prices are quoted in."
        >
          <Input
            id="{uid}-currency"
            name="currency"
            list="{uid}-currencies"
            required
            maxlength={3}
            minlength={3}
            autocapitalize="characters"
            autocomplete="off"
            class="font-mono uppercase"
            bind:value={currency}
            aria-invalid={!!errors.currency}
          />
          <datalist id="{uid}-currencies">
            {#each COMMON_CURRENCIES as c (c)}
              <option value={c}></option>
            {/each}
          </datalist>
        </FormField>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="ISIN (optional)"
          for="{uid}-isin"
          errors={errors.isin}
        >
          <Input
            id="{uid}-isin"
            name="isin"
            maxlength={12}
            autocapitalize="characters"
            autocomplete="off"
            class="font-mono uppercase"
            bind:value={isin}
            aria-invalid={!!errors.isin}
          />
        </FormField>
        <FormField
          label="Symbol (optional)"
          for="{uid}-symbol"
          errors={errors.symbol}
          hint="For automatic prices, e.g. VWRL.SW. Leave empty to enter prices by hand."
        >
          <Input
            id="{uid}-symbol"
            name="symbol"
            maxlength={24}
            autocapitalize="characters"
            autocomplete="off"
            class="font-mono uppercase"
            bind:value={symbol}
            aria-invalid={!!errors.symbol}
          />
        </FormField>
      </div>

      {#if errors.form?.length}
        <p class="text-destructive text-sm" role="alert">
          {errors.form.join(" ")}
        </p>
      {/if}
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (open = false)}
          disabled={pending}>Cancel</Button
        >
        <Button type="submit" disabled={pending}>
          {#if pending}<Spinner />{/if}
          {editing ? "Save" : "Add security"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
