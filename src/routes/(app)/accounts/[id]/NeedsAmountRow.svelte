<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import Amount from "$lib/components/Amount.svelte";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { minor } from "$lib/money";
  import LinkIcon from "@lucide/svelte/icons/link";
  import { usePreferences } from "$lib/preferences.svelte";
  import type { NeedsAmountView } from "$lib/server/transfers/manual";

  const prefs = usePreferences();

  let { item }: { item: NeedsAmountView } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let linking = $state(false);
  let linkErrors = $state<NonNullable<FormErrors>>({});

  const incoming = $derived(item.direction === "in");
</script>

<li class="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
  <div class="grid min-w-0 gap-0.5 text-sm">
    <p class="break-words">
      <span class="font-medium">{incoming ? "From" : "To"}</span>
      <a
        href={resolve("/(app)/accounts/[id]", { id: item.sourceAccountId })}
        class="font-medium underline-offset-2 hover:underline"
      >
        {item.sourceAccountName}
      </a>
      <span class="text-muted-foreground">
        on {prefs.date(item.bookingDate)}
      </span>
    </p>
    {#if item.description}
      <p class="text-muted-foreground truncate text-xs">{item.description}</p>
    {/if}
    <p class="text-muted-foreground text-xs">
      {incoming ? "Paid" : "Received"}
      <Amount
        value={minor(Math.abs(item.amount))}
        currency={item.currency}
        class="text-foreground"
      />
    </p>
  </div>
  <div class="grid gap-2">
    {#if item.linkCandidate}
      <form
        method="POST"
        action="?/linkNeedsAmount"
        class="bg-muted/50 grid gap-1.5 rounded-md p-2 text-xs"
        use:enhance={submitHandler({
          setPending: (v) => (linking = v),
          setErrors: (e) => (linkErrors = e),
          successMessage: "Transfer linked",
        })}
      >
        <input type="hidden" name="transferId" value={item.transferId} />
        <input type="hidden" name="peerId" value={item.linkCandidate.id} />
        <p>
          This account has a transaction on {prefs.date(
            item.linkCandidate.bookingDate,
          )}
          (<Amount
            value={item.linkCandidate.amount}
            currency={item.linkCandidate.currency}
            flow
          />) that may be the other side. Link it instead of entering an amount.
        </p>
        <div>
          <Button type="submit" size="sm" variant="outline" disabled={linking}>
            {#if linking}<Spinner />{:else}<LinkIcon />{/if}
            Link instead
          </Button>
        </div>
        {#if linkErrors.form?.length}
          <p class="text-destructive text-sm" role="alert">
            {linkErrors.form.join(" ")}
          </p>
        {/if}
      </form>
    {/if}
    <form
      method="POST"
      action="?/resolveNeedsAmount"
      class="grid gap-1.5"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: ["amount"],
        successMessage: "Transfer filled in",
      })}
    >
      <input type="hidden" name="transferId" value={item.transferId} />
      <div class="flex items-center gap-2">
        <label for="{uid}-amount" class="sr-only">
          Amount {incoming ? "received" : "paid"} in {item.targetCurrency}
        </label>
        <Input
          id="{uid}-amount"
          name="amount"
          inputmode="decimal"
          autocomplete="off"
          required
          placeholder="0.00"
          class="w-32 text-end tabular-nums"
          aria-invalid={!!errors.amount}
        />
        <span class="text-muted-foreground text-sm">{item.targetCurrency}</span>
        <Button type="submit" size="sm" disabled={pending}>
          {#if pending}<Spinner />{/if}
          Save
        </Button>
      </div>
      {#if errors.amount?.length}
        <p class="text-destructive text-sm" role="alert">{errors.amount[0]}</p>
      {/if}
      {#if errors.form?.length}
        <p class="text-destructive text-sm" role="alert">
          {errors.form.join(" ")}
        </p>
      {/if}
    </form>
  </div>
</li>
